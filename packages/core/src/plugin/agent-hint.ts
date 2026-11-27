export * as AgentHintPlugin from "./agent-hint.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { ConfigAgentHint } from "@opencode/schema/config/agent-hint"
import { Effect, Option, Schema, Scope, Stream } from "effect"
import { Config } from "../config.js"
import type { PluginInternal } from "./internal.js"

/**
 * Agent Hint v1: one `X-Agent-Hint` header on every main-line model request, plus session lifecycle
 * requests (`pause` / `resume` / `stop` / `compact`) to a configured control endpoint. The request
 * body is never touched. Opt-in through the `agent_hint` config key.
 *
 * The header tells an inference gateway which session/context a request belongs to, where it is in
 * the session lifecycle, whether the user is waiting, and whether the prefix is worth retaining.
 * Auxiliary requests (title, compaction, generate) never carry it.
 */

export type SessionState = "start" | "append" | "pause" | "resume" | "stop" | "compact"
export type ManageState = "pause" | "resume" | "stop" | "compact"
export type ContextEdit = "offload" | "prefetch" | "evict"

export interface Hint {
  readonly session: {
    readonly session_id: string
    readonly call_index: number
    readonly epoch: number
    readonly state: SessionState
  }
  readonly context_management?: {
    readonly manage_request: true
    readonly edits: ReadonlyArray<{ readonly type: ContextEdit; readonly target: "session" }>
  }
  readonly priority_control?: {
    readonly priority: { readonly level: 1 | 3; readonly reason: "user_waiting" | "critical_path" }
  }
  readonly cache_control?: {
    readonly type: "ephemeral"
    readonly ttl_s: number
    readonly msg_offset: number
  }
}

export const EDIT: Readonly<Record<ManageState, ContextEdit>> = {
  pause: "offload",
  resume: "prefetch",
  stop: "evict",
  compact: "evict",
}

const TTL_MIN = 60
const TTL_MAX = 3600
const TTL_FALLBACK_GAP_MS = 300_000
const TTL_FACTOR = 2
const MIN_PREFIX_TOKENS = 128
const CONTROL_TIMEOUT = "5 seconds"

/** Encode a hint as the `X-Agent-Hint` header value (base64url, no padding). */
export const encodeHint = (hint: Hint) => Buffer.from(JSON.stringify(hint), "utf8").toString("base64url")

/** The request's logical message count: one system message plus each conversation message. */
export const wireCount = (input: { readonly system: number; readonly messages: number }) =>
  (input.system > 0 ? 1 : 0) + input.messages

/** Retention TTL: twice the observed gap, clamped, 600 s without a sample. */
export const deriveTtl = (gapMs?: number) => {
  const seconds = gapMs !== undefined && Number.isFinite(gapMs) && gapMs > 0 ? gapMs / 1000 : TTL_FALLBACK_GAP_MS / 1000
  return Math.min(TTL_MAX, Math.max(TTL_MIN, Math.round(seconds * TTL_FACTOR)))
}

const CJK: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
]

/** CJK-aware prefix estimate: one token per CJK character, one per four others. */
export const estimateTokens = (texts: Iterable<string>) => {
  let cjk = 0
  let other = 0
  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      if (CJK.some(([low, high]) => code >= low && code <= high)) cjk += 1
      else other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

export interface CacheFacts {
  /** Wire message count of this request. */
  readonly offset: number
  /** Estimated prefix size; below one engine block the declaration is pointless. */
  readonly tokens: number
  /** Model plus sorted tool names, so a changed prefix is not pinned under the old key. */
  readonly signature: string
  readonly previousSignature?: string
  /** First call of the session, before any signature is recorded. */
  readonly firstCall: boolean
  /** A rewrite invalidated the previous prefix. */
  readonly afterRewrite: boolean
  readonly gapMs?: number
}

export const buildCache = (facts: CacheFacts): Hint["cache_control"] | undefined => {
  if (facts.afterRewrite) return undefined
  if (facts.offset < 1) return undefined
  if (facts.tokens > 0 && facts.tokens < MIN_PREFIX_TOKENS) return undefined
  const stable = facts.previousSignature === undefined ? facts.firstCall : facts.previousSignature === facts.signature
  if (!stable) return undefined
  return { type: "ephemeral", ttl_s: deriveTtl(facts.gapMs), msg_offset: facts.offset }
}

export const buildManage = (input: {
  readonly sessionID: string
  readonly state: ManageState
  readonly callIndex: number
  readonly epoch: number
}): Hint => ({
  session: {
    session_id: input.sessionID,
    call_index: input.callIndex,
    epoch: input.epoch,
    state: input.state,
  },
  context_management: {
    manage_request: true,
    edits: [{ type: EDIT[input.state], target: "session" }],
  },
})

interface Settings {
  readonly control?: string
  readonly providers?: readonly string[]
  readonly priority: boolean
  readonly cache: boolean
}

interface Facts {
  readonly sessionID: string
  calls: number
  epoch: number
  offset: number
  tokens: number
  tools: string[]
  signature?: string
  turnOpening: boolean
  rewrite: boolean
  fresh: boolean
  model: string
  hint?: Hint
  paused: boolean
  stopSent: boolean
}

export const Plugin = define({
  id: "opencode.agent_hint",
  effect: Effect.fn("AgentHintPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const facts = new Map<string, Facts>()
    const idle = new Set<string>()
    let lastActive: string | undefined

    const fact = (sessionID: string): Facts => {
      const existing = facts.get(sessionID)
      if (existing) return existing
      const created: Facts = {
        sessionID,
        calls: 0,
        epoch: 0,
        offset: 0,
        tokens: 0,
        tools: [],
        turnOpening: false,
        rewrite: false,
        fresh: false,
        model: "",
        paused: false,
        stopSent: false,
      }
      facts.set(sessionID, created)
      return created
    }

    const settings = Effect.fn("AgentHintPlugin.settings")(function* () {
      const value = Config.latest(yield* config.entries(), "agent_hint")
      if (value === undefined || value === false) return undefined
      const info =
        value === true ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ConfigAgentHint.Info)(value))
      return {
        ...(info?.control === undefined ? {} : { control: info.control }),
        ...(info?.providers === undefined ? {} : { providers: info.providers }),
        priority: info?.priority !== false,
        cache: info?.cache !== false,
      } satisfies Settings
    })

    const manage = Effect.fn("AgentHintPlugin.manage")(function* (
      setting: Settings,
      target: Facts,
      state: ManageState,
      epoch = target.epoch,
    ) {
      if (setting.control === undefined) return
      const hint = buildManage({
        sessionID: target.sessionID,
        state,
        callIndex: Math.max(1, state === "resume" ? target.calls + 1 : target.calls),
        epoch,
      })
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(setting.control!, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", "x-agent-hint": encodeHint(hint) },
            body: JSON.stringify({ model: target.model, messages: [], stream: false }),
            signal,
          }),
        catch: (error) => error,
      }).pipe(Effect.timeout(CONTROL_TIMEOUT), Effect.option)
      if (Option.isNone(response)) {
        yield* Effect.logWarning("agent hint manage request failed", { sessionID: target.sessionID, state })
        return
      }
      yield* Effect.promise(() => response.value.body?.cancel() ?? Promise.resolve())
      if (!response.value.ok)
        yield* Effect.logWarning("agent hint manage request rejected", {
          sessionID: target.sessionID,
          state,
          status: response.value.status,
        })
    })

    const allowed = (setting: Settings, providerID: string) =>
      setting.providers === undefined || setting.providers.length === 0 || setting.providers.includes(providerID)

    // Prefix facts for the primary request currently being prepared.
    yield* ctx.session.hook("context", (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        const target = fact(String(event.sessionID))
        target.tools = Object.keys(event.tools)
        target.offset = wireCount({ system: event.system.length, messages: event.messages.length })
        target.tokens =
          estimateTokens(event.system.map((part) => part.text)) + estimateTokens([JSON.stringify(event.messages)])
      }),
    )

    // A real user prompt opens a turn; the next primary request carries the user-waiting priority.
    yield* ctx.session.hook("prompt", (event: SessionHooks["prompt"]) =>
      Effect.sync(() => {
        fact(String(event.sessionID)).turnOpening = true
      }),
    )

    yield* ctx.session.hook("model.request", (event: SessionHooks["model.request"]) =>
      Effect.gen(function* () {
        if (event.kind !== "primary") return
        const setting = yield* settings()
        if (setting === undefined || !allowed(setting, event.model.providerID)) return
        const target = fact(String(event.sessionID))
        if (target.paused) {
          yield* manage(setting, target, "resume")
          target.paused = false
        }
        if (lastActive !== undefined && lastActive !== target.sessionID) {
          const previous = facts.get(lastActive)
          if (previous !== undefined && idle.has(previous.sessionID) && !previous.paused) {
            previous.paused = true
            yield* Effect.forkIn(manage(setting, previous, "pause"), scope)
          }
        }
        lastActive = target.sessionID
        idle.delete(target.sessionID)
        target.calls += 1
        target.model = event.model.id
        const opening = target.turnOpening || (target.calls === 1 && target.fresh)
        target.turnOpening = false
        const signature = `${event.model.providerID}/${event.model.id}:${[...target.tools].sort().join(",")}`
        const cache = setting.cache
          ? buildCache({
              offset: target.offset,
              tokens: target.tokens,
              signature,
              ...(target.signature === undefined ? {} : { previousSignature: target.signature }),
              firstCall: target.calls === 1,
              afterRewrite: target.rewrite,
            })
          : undefined
        target.signature = signature
        target.rewrite = false
        const hint: Hint = {
          session: {
            session_id: target.sessionID,
            call_index: target.calls,
            epoch: target.epoch,
            state: target.calls === 1 && target.fresh ? "start" : "append",
          },
          ...(setting.priority
            ? {
                priority_control: {
                  priority: opening
                    ? ({ level: 3, reason: "user_waiting" } as const)
                    : ({ level: 1, reason: "critical_path" } as const),
                },
              }
            : {}),
          ...(cache === undefined ? {} : { cache_control: cache }),
        }
        target.hint = hint
        event.headers["X-Agent-Hint"] = encodeHint(hint)
      }),
    )

    // WebSocket sessions read headers from the handshake, not the prepared request. The hint changes
    // every call, so it is marked volatile to keep the channel open.
    yield* ctx.session.hook("experimental.ws.handshake", (event: SessionHooks["experimental.ws.handshake"]) =>
      Effect.sync(() => {
        const target = facts.get(String(event.sessionID))
        if (target?.hint === undefined) return
        event.headers["X-Agent-Hint"] = encodeHint(target.hint)
        event.volatileHeaders = [...(event.volatileHeaders ?? []), "X-Agent-Hint"]
      }),
    )

    yield* ctx.session.hook("experimental.idle", (event: SessionHooks["experimental.idle"]) =>
      Effect.sync(() => {
        idle.add(String(event.sessionID))
      }),
    )

    // Lifecycle facts come from the event log, so they survive a request that rewrites history.
    yield* ctx.event
      .subscribe({ types: ["session.created", "session.deleted", "session.archived", "session.compaction.ended"] })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "session.created") {
              fact(String(event.data.sessionID)).fresh = true
              return
            }
            const current = yield* settings()
            if (current === undefined) return
            const target = fact(String(event.data.sessionID))
            if (event.type === "session.compaction.ended") {
              const previous = target.epoch
              target.epoch += 1
              target.rewrite = true
              yield* Effect.forkIn(manage(current, target, "compact", previous), scope)
              return
            }
            if (target.stopSent) return
            target.stopSent = true
            yield* Effect.forkIn(manage(current, target, "stop"), scope)
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
  }),
} satisfies PluginInternal.InternalPlugin)

import { describe, expect, test } from "bun:test"
import { AgentHintPlugin } from "@opencode/core/plugin/agent-hint"

const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"))

describe("agent hint protocol", () => {
  test("encodes base64url without padding and keeps JSON number and boolean types", () => {
    const hint = {
      session: { session_id: "ses_1", call_index: 2, epoch: 1, state: "append" as const },
      priority_control: { priority: { level: 3 as const, reason: "user_waiting" as const } },
      cache_control: { type: "ephemeral" as const, ttl_s: 600, msg_offset: 4 },
    }
    const header = AgentHintPlugin.encodeHint(hint)
    expect(header).not.toContain("=")
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decode(header)).toEqual(hint)
    expect(typeof decode(header).session.call_index).toBe("number")
  })

  test("counts one system message plus each conversation message", () => {
    expect(AgentHintPlugin.wireCount({ system: 1, messages: 0 })).toBe(1)
    expect(AgentHintPlugin.wireCount({ system: 1, messages: 3 })).toBe(4)
    expect(AgentHintPlugin.wireCount({ system: 0, messages: 2 })).toBe(2)
  })

  test("derives the retention ttl from the gap, clamped, 600 without a sample", () => {
    expect(AgentHintPlugin.deriveTtl()).toBe(600)
    expect(AgentHintPlugin.deriveTtl(0)).toBe(600)
    expect(AgentHintPlugin.deriveTtl(1_000)).toBe(60)
    expect(AgentHintPlugin.deriveTtl(60_000)).toBe(120)
    expect(AgentHintPlugin.deriveTtl(86_400_000)).toBe(3_600)
  })

  test("estimates cjk at one token and other text at four characters per token", () => {
    expect(AgentHintPlugin.estimateTokens(["你好"])).toBe(2)
    expect(AgentHintPlugin.estimateTokens(["abcd"])).toBe(1)
    expect(AgentHintPlugin.estimateTokens(["你好", "abcdefgh"])).toBe(4)
  })

  const cache = (override: Partial<Parameters<typeof AgentHintPlugin.buildCache>[0]> = {}) =>
    AgentHintPlugin.buildCache({
      offset: 4,
      tokens: 1_000,
      signature: "model:read",
      firstCall: false,
      previousSignature: "model:read",
      afterRewrite: false,
      ...override,
    })

  test("emits one ephemeral declaration whose offset is the wire count", () => {
    expect(cache()).toEqual({ type: "ephemeral", ttl_s: 600, msg_offset: 4 })
  })

  test("suppresses the declaration after a rewrite, on a signature change, or under one block", () => {
    expect(cache({ afterRewrite: true })).toBeUndefined()
    expect(cache({ previousSignature: "model:read,grep" })).toBeUndefined()
    expect(cache({ tokens: 127 })).toBeUndefined()
    expect(cache({ offset: 0 })).toBeUndefined()
  })

  test("treats a first call as stable only before a signature is recorded", () => {
    expect(cache({ firstCall: true, previousSignature: undefined })).toBeDefined()
    expect(cache({ firstCall: false, previousSignature: undefined })).toBeUndefined()
  })

  test("builds manage hints with the verb's edit and no priority or cache blocks", () => {
    const verbs: ReadonlyArray<readonly [AgentHintPlugin.ManageState, AgentHintPlugin.ContextEdit]> = [
      ["pause", "offload"],
      ["resume", "prefetch"],
      ["stop", "evict"],
      ["compact", "evict"],
    ]
    for (const [state, edit] of verbs) {
      const hint = AgentHintPlugin.buildManage({
        sessionID: "ses_1",
        state,
        callIndex: 3,
        epoch: 0,
      })
      expect(hint.context_management).toEqual({ manage_request: true, edits: [{ type: edit, target: "session" }] })
      expect(hint.session.state).toBe(state)
      expect(hint.priority_control).toBeUndefined()
      expect(hint.cache_control).toBeUndefined()
    }
  })
})

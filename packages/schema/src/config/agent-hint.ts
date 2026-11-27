export * as ConfigAgentHint from "./agent-hint.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.AgentHint")({
  providers: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Provider ids that receive session hints (default: every provider)",
  }),
  control: Schema.String.pipe(optional).annotate({
    description:
      "Endpoint that receives pause/resume/stop/compact manage requests; omitted disables lifecycle requests",
  }),
  priority: Schema.Boolean.pipe(optional).annotate({
    description: "Send the two-level soft priority with each hint (default: true)",
  }),
  cache: Schema.Boolean.pipe(optional).annotate({
    description: "Send the cache retention declaration with each hint (default: true)",
  }),
}) {}

export const AgentHint = Schema.Union([Schema.Boolean, Info])

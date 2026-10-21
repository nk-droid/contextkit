// Shared by the exporter, browser importer, and API. One contract for every boundary.
import { z } from "zod";
import { NetworkFactsSchema, lifecycles } from "../../../src/network/schema.mjs";
export { NetworkFactsSchema, lifecycles, parseNetworkFacts } from "../../../src/network/schema.mjs";
export type NetworkFacts = z.infer<typeof NetworkFactsSchema>;
export type Grounding = NetworkFacts["architecture"]["components"][number]["grounding"];
export type Lifecycle = (typeof lifecycles)[number];
export type CodeSymbol = NetworkFacts["code"]["symbols"][number];
export type EvidenceRecord = NetworkFacts["evidence"][number];

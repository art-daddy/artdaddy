// Tools this client still implements but the server has withdrawn from the catalog. They are kept
// so bringing one back is a server-side line change rather than restoring deleted code — see
// RETIRED_TOOLS in the server's tools/definitions.py.
//
// This list is ACKNOWLEDGEMENT, not policy: the catalog decides what is callable (mcp/bridge.ts
// refuses anything it does not offer). Its only job is to keep "deliberately withdrawn" distinct
// from "the client and the contract have drifted", which the conformance tests would otherwise
// report identically. conformance.test.ts asserts it matches reality in both directions, so a
// tool withdrawn server-side fails here until someone acknowledges it.
export const WITHDRAWN_TOOLS: readonly string[] = [
  "extract_style",
  "find_content",
  "get_page",
  "image_ask",
  "probe_media",
  "vision_describe",
];

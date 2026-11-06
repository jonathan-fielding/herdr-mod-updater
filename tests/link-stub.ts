/**
 * Preloaded into a CLI started with spawnSync, where a server in the test can't answer: `hmod link`
 * finds every repo, with the ids that go with its name. Nothing else gets an answer, or the network.
 */
import { repoDetails } from "./repo-ids.ts";

globalThis.fetch = (async (url: string) => {
  const repo = new URL(url).pathname.match(/^\/repos\/([^/]+\/[^/]+)$/)?.[1];
  return repo ? Response.json(repoDetails(repo)) : new Response("{}", { status: 404 });
}) as typeof fetch;

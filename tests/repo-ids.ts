/** The ids a repo has in the tests, stable for its name. Shared by the fake and the link stub. */
const id = (text: string) => Bun.hash.crc32(text);

export const repoIds = (fullName: string) => ({ repo_id: id(`repo ${fullName}`), owner_id: id(`owner ${fullName.split("/")[0]}`) });

/** GET /repos/owner/repo, as GitHub answers it. */
export function repoDetails(fullName: string, over: { repo_id?: number; owner_id?: number } = {}) {
  const { repo_id, owner_id } = { ...repoIds(fullName), ...over };
  return { id: repo_id, full_name: fullName, default_branch: "main", owner: { id: owner_id, login: fullName.split("/")[0] } };
}

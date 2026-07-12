export type DeterministicGitHubFixtureOptions = {
  releases: Readonly<Record<string, string>>;
  responses: Readonly<Record<string, unknown>>;
};

export class DeterministicGitHubFixture {
  readonly requests: string[] = [];
  readonly releaseSource: { resolve(versionId: string): Promise<unknown> };
  readonly fetch: (request: Request) => Promise<Response>;
  readonly #releases: ReadonlyMap<string, string>;
  readonly #responses: ReadonlyMap<string, unknown>;

  constructor(options: DeterministicGitHubFixtureOptions) {
    this.#releases = new Map(Object.entries(options.releases));
    this.#responses = new Map(Object.entries(options.responses));
    this.releaseSource = {
      resolve: async (versionId) => {
        const commitSha = this.#releases.get(versionId);
        return commitSha === undefined ? null : { versionId, commitSha };
      },
    };
    this.fetch = async (request) => {
      const url = new URL(request.url);
      const key = `${url.pathname}${url.search}`;
      this.requests.push(key);
      if (!this.#responses.has(key)) {
        return Response.json({ message: "Fixture route not found." }, { status: 404 });
      }
      return Response.json(this.#responses.get(key));
    };
  }
}

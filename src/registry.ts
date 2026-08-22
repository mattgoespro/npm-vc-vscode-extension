import * as https from "https";
import * as http from "http";
import { URL } from "url";

interface CacheEntry {
  /** `null` means "looked up, but no usable version" (missing / errored). */
  value: string | null;
  expires: number;
}

/**
 * Small, self-contained client for resolving the `latest` dist-tag of a package
 * from an npm registry. Results are cached in-memory with a TTL so that typing
 * in the editor (which re-triggers analysis) does not hammer the registry, and
 * concurrent lookups for the same name share a single in-flight request.
 */
export class RegistryClient {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<string | null>>();

  constructor(
    private registryBase: string,
    private ttlSeconds: number,
  ) {}

  update(registryBase: string, ttlSeconds: number): void {
    if (registryBase !== this.registryBase) {
      // A registry switch invalidates every cached answer.
      this.cache.clear();
    }
    this.registryBase = registryBase;
    this.ttlSeconds = ttlSeconds;
  }

  /** Drop all cached answers (used by the manual "refresh" command). */
  clear(): void {
    this.cache.clear();
  }

  async getLatestVersion(name: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && cached.expires > now) {
      return cached.value;
    }

    const existing = this.inflight.get(name);
    if (existing) {
      return existing;
    }

    const request = this.fetchLatest(name)
      .then((value) => {
        this.cache.set(name, {
          value,
          expires: Date.now() + this.ttlSeconds * 1000,
        });
        return value;
      })
      .catch(() => {
        // Cache the failure briefly so a flaky/offline registry doesn't stall
        // every keystroke, but recover quickly once connectivity returns.
        this.cache.set(name, {
          value: null,
          expires: Date.now() + Math.min(this.ttlSeconds, 30) * 1000,
        });
        return null;
      })
      .finally(() => {
        this.inflight.delete(name);
      });

    this.inflight.set(name, request);
    return request;
  }

  private buildUrl(name: string): string {
    // Scoped packages ("@scope/name") must have their slash percent-encoded,
    // but the leading "@" is fine in a path segment.
    const encoded = name.startsWith("@")
      ? "@" + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    const base = this.registryBase.replace(/\/+$/, "");
    return `${base}/${encoded}/latest`;
  }

  private fetchLatest(name: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(this.buildUrl(name));
      } catch (err) {
        reject(err);
        return;
      }

      const transport = url.protocol === "http:" ? http : https;
      const req = transport.get(
        url,
        {
          headers: {
            // The abbreviated metadata document is smaller and fully sufficient
            // for reading `version`.
            Accept:
              "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
            "User-Agent": "npm-version-control-vscode",
          },
          timeout: 10000,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 404) {
            // Package (or the "latest" tag) does not exist — not an error.
            res.resume();
            resolve(null);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(
              new Error(`Registry responded with HTTP ${status} for ${name}`),
            );
            return;
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => {
            try {
              const body = Buffer.concat(chunks).toString("utf8");
              const parsed = JSON.parse(body);
              const version =
                typeof parsed?.version === "string" ? parsed.version : null;
              resolve(version);
            } catch (err) {
              reject(err);
            }
          });
        },
      );

      req.on("timeout", () =>
        req.destroy(new Error(`Registry request for ${name} timed out`)),
      );
      req.on("error", reject);
    });
  }
}

import type { Clock } from "~/services";

/** Failures in the trailing window that lock a username. */
export const USERNAME_FAILURE_LIMIT = 5;
/** The trailing window username failures are counted in. */
export const USERNAME_WINDOW_MS = 15 * 60 * 1000;
/** How long a lock lasts, from the failure that set it. */
export const LOCK_MS = 15 * 60 * 1000;
/** Failures in the trailing window after which an IP is refused. */
export const IP_FAILURE_LIMIT = 20;
/** The trailing window IP failures are counted in; older rows are pruned. */
export const IP_WINDOW_MS = 60 * 60 * 1000;

/**
 * The key an IP's failures are counted under: the client address Cloudflare
 * puts in CF-Connecting-IP, or `unknown` when the header is missing. An IPv6
 * address is keyed by its /64 prefix (see `ipv6Prefix64`), since one
 * subscriber network can rotate through the addresses inside it.
 */
export function clientIp(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return ip.includes(":") ? ipv6Prefix64(ip) : ip;
}

/**
 * The /64 prefix of an IPv6 address in one canonical form: the first four
 * hextets expanded to four lower-case digits, then `::/64`, so
 * `2001:DB8:1:2::1` gives `2001:0db8:0001:0002::/64`. `::` compression and a
 * trailing dotted IPv4 part are expanded first. A malformed address is
 * returned lower-cased as it is.
 */
export function ipv6Prefix64(address: string): string {
  const lower = address.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return lower;
  const groups = (half: string | undefined) =>
    !half ? [] : half.split(":").flatMap((part) => (part.includes(".") ? ["0", "0"] : [part]));
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return lower;
  const hextets = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!hextets.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return lower;
  return `${hextets
    .slice(0, 4)
    .map((part) => part.padStart(4, "0"))
    .join(":")}::/64`;
}

/**
 * When the latest lock among these username failures ends, or null when they
 * never reached the limit. A failure sets a lock when it brings the failures
 * in the trailing window to the limit. `failures` must be in ascending order.
 */
export function lockEnd(failures: readonly Date[]): Date | null {
  let end: Date | null = null;
  for (let i = USERNAME_FAILURE_LIMIT - 1; i < failures.length; i++) {
    const first = failures[i - USERNAME_FAILURE_LIMIT + 1];
    if (failures[i].getTime() - first.getTime() < USERNAME_WINDOW_MS) {
      end = new Date(failures[i].getTime() + LOCK_MS);
    }
  }
  return end;
}

/**
 * The login limits, on D1's `login_failures` table and the injected clock.
 * Callers pass `usernameKey()` of the typed username and `clientIp()` of the
 * request. Concurrent attempts can each pass `admit` before any failure is
 * recorded, so a burst may get one or two attempts past a limit.
 */
export function createLoginLimits({ db, clock }: { db: D1Database; clock: Clock }) {
  function isoBefore(now: Date, ms: number): string {
    return new Date(now.getTime() - ms).toISOString();
  }

  function insertFailure(kind: "username" | "ip", key: string, now: Date): D1PreparedStatement {
    return db
      .prepare("INSERT INTO login_failures (kind, key, failed_at) VALUES (?1, ?2, ?3)")
      .bind(kind, key, now.toISOString());
  }

  function prune(now: Date): D1PreparedStatement {
    return db.prepare("DELETE FROM login_failures WHERE failed_at <= ?1").bind(isoBefore(now, IP_WINDOW_MS));
  }

  return {
    /**
     * True when this attempt may check a password. A limited IP is refused
     * and nothing is recorded; a locked username is refused and the attempt
     * records an IP failure, which does not extend the lock.
     */
    async admit(usernameKey: string, ip: string): Promise<boolean> {
      const now = clock.now();
      const [ipCount, usernameFailures] = await db.batch<{ n?: number; failed_at?: string }>([
        db
          .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE kind = 'ip' AND key = ?1 AND failed_at > ?2")
          .bind(ip, isoBefore(now, IP_WINDOW_MS)),
        // A lock still running started within LOCK_MS, from a failure with the
        // rest of its window before it.
        db
          .prepare(
            "SELECT failed_at FROM login_failures WHERE kind = 'username' AND key = ?1 AND failed_at > ?2 ORDER BY failed_at",
          )
          .bind(usernameKey, isoBefore(now, LOCK_MS + USERNAME_WINDOW_MS)),
      ]);
      if ((ipCount.results[0]?.n ?? 0) >= IP_FAILURE_LIMIT) return false;

      const end = lockEnd(usernameFailures.results.map((row) => new Date(row.failed_at ?? "")));
      if (end && now < end) {
        await db.batch([insertFailure("ip", ip, now), prune(now)]);
        return false;
      }
      return true;
    },

    /** Records a failed attempt that `admit` let through, and prunes old rows. */
    async recordFailure(usernameKey: string, ip: string): Promise<void> {
      const now = clock.now();
      await db.batch([insertFailure("username", usernameKey, now), insertFailure("ip", ip, now), prune(now)]);
    },

    /**
     * Records a failed attempt that counts for the IP only, such as a username
     * no login can have, and prunes old rows.
     */
    async recordIpFailure(ip: string): Promise<void> {
      const now = clock.now();
      await db.batch([insertFailure("ip", ip, now), prune(now)]);
    },

    /** Deletes a username's failures; batch it with the successful login or password change. */
    clearUsername(usernameKey: string): D1PreparedStatement {
      return db.prepare("DELETE FROM login_failures WHERE kind = 'username' AND key = ?1").bind(usernameKey);
    },
  };
}

export type LoginLimits = ReturnType<typeof createLoginLimits>;

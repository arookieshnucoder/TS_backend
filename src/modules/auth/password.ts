import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
const iterations = 600000;
const dummy = `pbkdf2-sha256$${iterations}$${"0".repeat(32)}$${"0".repeat(64)}`;

/** Salt + slow SHA-256 derivation. The stored envelope supports future upgrades. */
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const hash = await derive(password, salt, iterations, 32, "sha256");
    return `pbkdf2-sha256$${iterations}$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded = dummy): Promise<boolean> {
    const match = /^pbkdf2-sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
    if (!match || Number(match[1]) < iterations || Number(match[1]) > 2000000) return false;
    const actual = await derive(password, match[2]!, Number(match[1]), 32, "sha256");
    return timingSafeEqual(actual, Buffer.from(match[3]!, "hex"));
}

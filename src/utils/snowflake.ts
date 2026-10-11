// 41-bit milliseconds + 10-bit worker + 12-bit sequence. Return strings: JS numbers lose precision.
export class SnowflakeIdGenerator {
  static readonly epoch = Date.UTC(2024, 0, 1);
  private lastTimestamp = -1;
  private sequence = 0;
  constructor(private readonly workerId = 0, private readonly clock: () => number = Date.now) {
    if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) throw new Error("SNOWFLAKE_WORKER_ID must be 0..1023");
  }
  nextId(): string {
    const timestamp = this.clock();
    if (!Number.isSafeInteger(timestamp) || timestamp < SnowflakeIdGenerator.epoch
      || timestamp - SnowflakeIdGenerator.epoch >= 2 ** 41) throw new Error("Snowflake timestamp out of range");
    // Fail instead of silently producing duplicate IDs after clock rollback or sequence exhaustion.
    if (timestamp < this.lastTimestamp) throw new Error("Snowflake clock moved backwards");
    if (timestamp === this.lastTimestamp) {
      if (this.sequence === 4095) throw new Error("Snowflake sequence exhausted; retry next millisecond");
      this.sequence++;
    } else { this.sequence = 0; this.lastTimestamp = timestamp; }
    return ((BigInt(timestamp - SnowflakeIdGenerator.epoch) << 22n)
      | (BigInt(this.workerId) << 12n) | BigInt(this.sequence)).toString();
  }
}
const generator = new SnowflakeIdGenerator(Number(process.env.SNOWFLAKE_WORKER_ID ?? "0"));
export const generateId = (): string => generator.nextId();

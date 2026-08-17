export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function isoNow(clock: Clock = systemClock): string {
  return clock().toISOString();
}

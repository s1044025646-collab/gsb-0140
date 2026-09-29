// Injectable clock and id generator so tests can control time and
// determinism while production code uses the real implementations.

export interface Clock {
  now(): string; // ISO-8601 UTC
  randomUuid(): string;
}

export const realClock: Clock = {
  now() {
    return new Date().toISOString();
  },
  randomUuid() {
    return crypto.randomUUID();
  },
};

export function fixedClock(iso: string, uuid?: string): Clock {
  let counter = 0;
  return {
    now() {
      return iso;
    },
    randomUuid() {
      if (uuid !== undefined) return uuid;
      counter++;
      return `fixed-${counter.toString().padStart(12, "0")}`;
    },
  };
}

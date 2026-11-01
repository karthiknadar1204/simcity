import type { Resources } from "@repo/contracts";
import { requireRule } from "./transition";

export function amount(resources: Resources, key: string) {
  return Object.hasOwn(resources, key) ? resources[key]! : 0;
}
export function total(resources: Resources) {
  return Object.values(resources).reduce((a, b) => a + b, 0);
}
export function scale(resources: Resources, units: number): Resources {
  return Object.fromEntries(
    Object.entries(resources).map(([key, value]) => {
      requireRule(
        Number.isSafeInteger(value * units),
        "Resource quantity is too large.",
      );
      return [key, value * units];
    }),
  );
}
export function change(
  resources: Resources,
  delta: Resources,
  direction: 1 | -1,
): Resources {
  const result = { ...resources };
  for (const [key, value] of Object.entries(delta)) {
    const next = amount(result, key) + direction * value;
    requireRule(
      Number.isSafeInteger(next) && next >= 0,
      "Insufficient resources or invalid quantity.",
    );
    Object.defineProperty(result, key, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

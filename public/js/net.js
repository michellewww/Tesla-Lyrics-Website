// A time limit for network requests. fetch() has none of its own, so on a car's patchy
// connection a stalled request would otherwise hang (and block retries) indefinitely.

export class TimeoutError extends Error {
  constructor(ms) {
    super(`Request timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Run `run(signal)` (a fetch plus reading its body) with a deadline. On timeout the
 * request is aborted where the browser supports it, and a TimeoutError is thrown.
 */
export async function withDeadline(ms, run) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(ms));
      ctrl?.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl?.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a graph edit kept the proofreader waiting, worded for the status
 * messages and panel lines that report it.
 *
 * Every edit measures the same span on purpose: the click through to the
 * segment changing on screen, server work and mesh refresh included. A number
 * covering only the request would read faster than the wait it describes.
 */

/** e.g. `editTookLabel("carve", startedAt)` → "carve took 1.31 sec". */
export function editTookLabel(edit: string, startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1000;
  return `${edit} took ${seconds.toFixed(2)} sec`;
}

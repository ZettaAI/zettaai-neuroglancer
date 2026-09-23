/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file How the trace sphere looks. The hue is shared so the 3D body and the
 * 2D cross-section read as one object; the opacities are not, because the two
 * are different things. The 3D body is a shell seen through both of its walls
 * and has to stay see-through; the 2D shape is a flat cut through the middle
 * and needs enough fill to be legible against the image.
 */

export const TRACE_SPHERE_RGB = Float32Array.of(0.35, 0.75, 1.0);

/**
 * Facing the viewer the shell is nearly clear, at the silhouette it is dense.
 * That difference IS the volume cue: a single flat opacity draws a disc no
 * matter how round the geometry is.
 *
 * The core value is per wall and both walls are drawn, so a pixel through the
 * middle of the sphere accumulates it roughly twice.
 */
export const TRACE_SPHERE_CORE_ALPHA = 0.07;
export const TRACE_SPHERE_RIM_ALPHA = 0.55;

export const TRACE_SPHERE_SLICE_FILL_ALPHA = 0.2;
export const TRACE_SPHERE_SLICE_OUTLINE_ALPHA = 0.9;

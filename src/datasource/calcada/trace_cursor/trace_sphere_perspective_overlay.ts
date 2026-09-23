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
 * @file The trace cursor sphere in the 3D panel.
 *
 * A translucent shell, not a wireframe: it has to read as a volume wrapped
 * around a stretch of mesh. It lives in world coordinates, so the perspective
 * projection alone makes it larger up close and smaller far away — there is no
 * screen-space sizing anywhere in here, and adding any would break exactly the
 * depth cue the sphere exists to give. (In the 3D panel's ORTHOGRAPHIC mode,
 * toggled with `o`, nothing changes size with depth by definition; that is the
 * projection talking, not this layer.)
 *
 * SHADING. Flat colour draws a disc however round the geometry is, so opacity
 * is driven by how edge-on the surface is: nearly clear where the shell faces
 * the viewer, dense where it turns away at the silhouette.
 *
 * Both walls are drawn, so the far one shows through the near one — the two
 * rims together are what make it read as glass rather than as a hole.
 *
 * The maths is done on the UNIT SPHERE, not in global coordinates, and that is
 * exact rather than an approximation: the semi-axes are `radiusNm` divided by
 * the nanometres per unit of each axis, so the unit sphere maps to physical
 * space by a plain uniform scale of `radiusNm`. Angles are therefore preserved,
 * and no normal matrix is needed even though the global grid is anisotropic.
 */

import {
  TRACE_SPHERE_CORE_ALPHA,
  TRACE_SPHERE_RGB,
  TRACE_SPHERE_RIM_ALPHA,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_appearance.js";
import {
  SPHERE_TRIANGLE_VERTEX_COUNT,
  buildUnitSphereTriangles,
  traceSphereSemiAxes,
} from "#src/datasource/calcada/trace_cursor/trace_sphere_geometry.js";
import type { TraceSphereState } from "#src/datasource/calcada/trace_cursor/trace_sphere_state.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ParameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import { parameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

// How sharply the shell thickens toward the silhouette. 1 is a wash, high
// values leave a hard ring with nothing inside it.
const RIM_FALLOFF_POWER = 2.5;
// Never fully dark: the unlit side still has to show where the shell is.
const AMBIENT = 0.6;
// A pure headlight lights the shell evenly and leaves it reading flat, so the
// light is nudged off the view axis. Sideways and upward relative to the camera,
// whichever way it happens to be turned.
const LIGHT_SIDE_BIAS = 0.45;
const LIGHT_UP_BIAS = 0.35;

const tempModel = mat4.create();
const tempMvp = mat4.create();
const tempEye = vec3.create();
const tempLight = vec3.create();
const tempAxis = vec3.create();

export class TraceSpherePerspectiveOverlay extends PerspectiveViewRenderLayer {
  private vertexBuffer: GLBuffer;
  private shaderGetter: ParameterizedEmitterDependentShaderGetter<null>;

  constructor(
    public gl: GL,
    public state: TraceSphereState,
  ) {
    super();
    this.shaderGetter = parameterizedEmitterDependentShaderGetter(this, gl, {
      memoizeKey: "calcada/trace_cursor/TraceSpherePerspectiveOverlay",
      parameters: constantWatchableValue(null),
      defineShader: (builder: ShaderBuilder) => defineShellShader(builder),
    });
    this.vertexBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        buildUnitSphereTriangles(),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.registerDisposer(
      state.visible.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(state.center.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
      state.radiusNm.changed.add(this.redrawNeeded.dispatch),
    );
  }

  get isTransparent() {
    return true;
  }

  draw(renderContext: PerspectiveViewRenderContext): void {
    if (!renderContext.emitColor) return;
    const { state, gl, vertexBuffer } = this;
    if (state.visible.value !== true) return;
    const center = state.center.value;
    if (center === undefined) return;
    const semiAxes = traceSphereSemiAxes(
      state.radiusNm.value,
      state.coordinateSpace.value,
    );
    if (semiAxes === undefined) return;

    const model = mat4.identity(tempModel);
    model[0] = semiAxes[0];
    model[5] = semiAxes[1];
    model[10] = semiAxes[2];
    model[12] = center[0];
    model[13] = center[1];
    model[14] = center[2];
    const { viewProjectionMat, invViewMatrix } =
      renderContext.projectionParameters;
    const mvp = mat4.multiply(tempMvp, viewProjectionMat, model);

    // invViewMatrix maps eye space to global, so its translation column is the
    // camera position; dividing by the semi-axes carries it into unit-sphere
    // space, where the shading is evaluated.
    vec3.set(
      tempEye,
      (invViewMatrix[12] - center[0]) / semiAxes[0],
      (invViewMatrix[13] - center[1]) / semiAxes[1],
      (invViewMatrix[14] - center[2]) / semiAxes[2],
    );
    vec3.normalize(tempLight, tempEye);
    // Columns 0 and 1 of the same matrix are the view's right and up axes. A
    // direction divides by the semi-axes just as the position does, which is
    // what keeps the light square with the physical shape on an anisotropic
    // grid rather than with the voxel grid.
    addViewAxis(tempLight, invViewMatrix, 0, semiAxes, LIGHT_SIDE_BIAS);
    addViewAxis(tempLight, invViewMatrix, 4, semiAxes, LIGHT_UP_BIAS);
    vec3.normalize(tempLight, tempLight);

    const { shader } = this.shaderGetter(renderContext.emitter);
    if (shader === null) return;
    shader.bind();
    gl.uniformMatrix4fv(shader.uniform("uProjectionMatrix"), false, mvp);
    gl.uniform3fv(shader.uniform("uColor"), TRACE_SPHERE_RGB);
    gl.uniform3fv(shader.uniform("uEyeInObject"), tempEye);
    gl.uniform3fv(shader.uniform("uLightInObject"), tempLight);
    gl.uniform1f(shader.uniform("uCoreAlpha"), TRACE_SPHERE_CORE_ALPHA);
    gl.uniform1f(shader.uniform("uRimAlpha"), TRACE_SPHERE_RIM_ALPHA);

    const aVertexPosition = shader.attribute("aVertexPosition");
    vertexBuffer.bindToVertexAttrib(aVertexPosition, 3);
    // Blend and depth state is left alone on purpose. isTransparent puts this
    // layer in the perspective panel's OIT pass, which configures blending once
    // for every transparent layer and for the final composite; setting our own
    // here blacks out the whole 3D view. That pass keeps depth-test on and
    // depth-write off, which is what makes a nearer mesh occlude the shell and
    // lets both of the shell's own walls survive into the composite.
    gl.drawArrays(gl.TRIANGLES, 0, SPHERE_TRIANGLE_VERTEX_COUNT);
    gl.disableVertexAttribArray(aVertexPosition);
  }
}

/** Add one of the view matrix's basis columns, carried into unit-sphere space. */
function addViewAxis(
  out: vec3,
  invViewMatrix: mat4,
  column: number,
  semiAxes: vec3,
  weight: number,
) {
  vec3.set(
    tempAxis,
    invViewMatrix[column] / semiAxes[0],
    invViewMatrix[column + 1] / semiAxes[1],
    invViewMatrix[column + 2] / semiAxes[2],
  );
  vec3.normalize(tempAxis, tempAxis);
  vec3.scaleAndAdd(out, out, tempAxis, weight);
}

/**
 * The fragment output goes through the pass's emitter (`emit(color, pickId)` —
 * OIT accumulate/revealage in the transparent pass), so the shell composites
 * correctly whichever pass draws it. It is non-pickable: pickId 0.
 */
function defineShellShader(builder: ShaderBuilder) {
  builder.addAttribute("vec3", "aVertexPosition");
  builder.addVarying("highp vec3", "vObjectPosition");
  builder.addUniform("mat4", "uProjectionMatrix");
  builder.addUniform("vec3", "uColor");
  builder.addUniform("highp vec3", "uEyeInObject");
  builder.addUniform("highp vec3", "uLightInObject");
  builder.addUniform("highp float", "uCoreAlpha");
  builder.addUniform("highp float", "uRimAlpha");
  builder.setVertexMain(`
vObjectPosition = aVertexPosition;
gl_Position = uProjectionMatrix * vec4(aVertexPosition, 1.0);
`);
  builder.setFragmentMain(`
// On the unit sphere the position IS the outward normal.
vec3 normal = normalize(vObjectPosition);
vec3 toViewer = normalize(uEyeInObject - vObjectPosition);
// abs(), because the far wall faces away and would otherwise come out unlit
// and fully transparent, costing the shell half of its silhouette.
float facing = abs(dot(normal, toViewer));
float rim = pow(1.0 - facing, ${RIM_FALLOFF_POWER.toFixed(1)});
float lambert = max(dot(normal, uLightInObject), 0.0);
float shade = ${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * lambert;
emit(vec4(uColor * shade, mix(uCoreAlpha, uRimAlpha, rim)), 0u);
`);
}

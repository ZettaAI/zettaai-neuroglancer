/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import "#src/datasource/calcada/calcada.css";
import "#src/ui/segment_list.css";

import { debounce } from "lodash-es";

import {
  AnnotationDisplayState,
  AnnotationLayerState,
} from "#src/annotation/annotation_layer_state.js";
import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type {
  Annotation,
  AnnotationReference,
  AnnotationSource,
  Line,
  Point,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  LocalAnnotationSource,
  makeDataBoundsBoundingBoxAnnotationSet,
} from "#src/annotation/index.js";
import { LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type {
  ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface,
  ChunkedGraphChunkSpecification,
  HttpSource,
  MultiscaleMeshMetadata,
} from "#src/datasource/calcada/base.js";
import {
  CALCADA_BULK_LINK_RPC_ID,
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  ChunkedGraphSourceParameters,
  getCalcadaFragmentKey,
  getHttpSource,
  CALCADA_MESH_NEW_SEGMENT_RPC_ID,
  CALCADA_MESH_REFRESH_SEGMENT_RPC_ID,
  CALCADA_MESH_PREFETCH_SEGMENT_RPC_ID,
  isBaseSegmentId,
  makeChunkedGraphChunkSpecification,
  MeshSourceParameters,
  parseCalcadaError,
  PYCG_APP_VERSION,
  RENDER_RATIO_LIMIT,
  VolumeChunkSourceParameters as CalcadaVolumeChunkSourceParameters,
} from "#src/datasource/calcada/base.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import {
  dropDecided,
  nextCandidate,
} from "#src/datasource/calcada/candidate_ranking.js";
import {
  interceptedRemovals,
  TRACE_CANDIDATE_COLOR_PACKED,
  TRACE_CANDIDATE_DIM_COLOR_PACKED,
  TRACE_SEED_COLOR_PACKED,
  TRACE_SEED_DIM_COLOR_PACKED,
} from "#src/datasource/calcada/role_colors.js";
import {
  classifyCandidateEdit,
  isStaleRoot,
} from "#src/datasource/calcada/root_resolution.js";
import type {
  DataSource,
  DataSourceLookupResult,
  DataSubsourceEntry,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import {
  DataEncoding,
  ShardingHashFunction,
} from "#src/datasource/precomputed/base.js";
import type { MultiscaleVolumeInfo } from "#src/datasource/precomputed/frontend.js";
import {
  getSegmentPropertyMap,
  parseMultiscaleVolumeInfo,
  PrecomputedMultiscaleVolumeChunkSource,
} from "#src/datasource/precomputed/frontend.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  ensureEmptyUrlSuffix,
  kvstoreEnsureDirectoryPipelineUrl,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import type {
  LayerView,
  MouseSelectionState,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type { RenderLayer } from "#src/renderlayer.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type {
  SegmentationDisplayState3D,
  Uint64MapEntry,
} from "#src/segmentation_display_state/frontend.js";
import {
  augmentSegmentId,
  resetTemporaryVisibleSegmentsState,
  SegmentationLayerSharedObject,
  SegmentWidgetFactory,
} from "#src/segmentation_display_state/frontend.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type {
  ComputedSplit,
  SegmentationGraphSourceTab,
} from "#src/segmentation_graph/source.js";
import {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import type { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  FrontendTransformedSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
  SliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import {
  SliceViewPanelRenderLayer,
  SliceViewRenderLayer,
} from "#src/sliceview/renderlayer.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import { makeDefaultVolumeChunkSpecifications } from "#src/sliceview/volume/base.js";
import { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import {
  TrackableBoolean,
  TrackableBooleanCheckbox,
} from "#src/trackable_boolean.js";
import type {
  NestedStateManager,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  registerNested,
  TrackableValue,
  WatchableSet,
  WatchableValue,
} from "#src/trackable_value.js";
import {
  AnnotationLayerView,
  makeAnnotationListElement,
  MergedAnnotationStates,
  PlaceLineTool,
} from "#src/ui/annotations.js";
import { getDefaultAnnotationListBindings } from "#src/ui/default_input_event_bindings.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  makeToolButton,
  registerLegacyTool,
  registerTool,
} from "#src/ui/tool.js";
import { Uint64Set } from "#src/uint64_set.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { setClipboard } from "#src/util/clipboard.js";
import { packColor, useWhiteBackground } from "#src/util/color.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { mat4, vec3, vec4 } from "#src/util/geom.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseUint64,
  verify3dVec,
  verifyBoolean,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyFloatArray,
  verifyInt,
  verifyIntegerArray,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { KeyboardEventBinder } from "#src/util/keyboard_bindings.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { DateTimeInputWidget } from "#src/widget/datetime.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { makeEyeButton } from "#src/widget/eye_button.js";
import { makeIcon } from "#src/widget/icon.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";
import {
  addLayerControlToOptionsTab,
  registerLayerControl,
} from "#src/widget/layer_control.js";
import { Tab } from "#src/widget/tab_view.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerRPC } from "#src/worker_rpc.js";

function vec4FromVec3(vec: vec3, alpha = 0) {
  const res = vec4.clone([...vec]);
  res[3] = alpha;
  return res;
}

const RED_COLOR = vec3.fromValues(1, 0, 0);
const BLUE_COLOR = vec3.fromValues(0, 0, 1);
const GREEN_COLOR = vec3.fromValues(0, 1, 0);
const RED_COLOR_SEGMENT = vec4FromVec3(RED_COLOR, 0.5);
const BLUE_COLOR_SEGMENT = vec4FromVec3(BLUE_COLOR, 0.5);
const RED_COLOR_HIGHLIGHT = vec4FromVec3(RED_COLOR, 0.25);
const BLUE_COLOR_HIGHTLIGHT = vec4FromVec3(BLUE_COLOR, 0.25);
const TRANSPARENT_COLOR = vec4.fromValues(0.5, 0.5, 0.5, 0.01);
const RED_COLOR_SEGMENT_PACKED = BigInt(packColor(RED_COLOR_SEGMENT));
const BLUE_COLOR_SEGMENT_PACKED = BigInt(packColor(BLUE_COLOR_SEGMENT));
const TRANSPARENT_COLOR_PACKED = BigInt(packColor(TRANSPARENT_COLOR));
// A piece holding BOTH colours is the split target — tint it green so it stands
// out as "this piece will be cut" instead of looking deselected.
const SPLIT_TARGET_COLOR = vec4FromVec3(vec3.fromValues(0, 1, 0), 0.6);
const SPLIT_TARGET_COLOR_PACKED = BigInt(packColor(SPLIT_TARGET_COLOR));
// Distinct per-piece colours for the debug overlay (green is reserved for
// sibling edge lines, so it is intentionally excluded here).
const DEBUG_PIECE_PALETTE: bigint[] = (
  [
    [1, 0.5, 0],
    [0, 0.8, 0.8],
    [1, 0, 1],
    [1, 1, 0],
    [0.6, 0.2, 0.9],
    [0, 0.6, 0.5],
    [1, 0.4, 0.7],
    [0.6, 0.4, 0.2],
    [0.7, 0.9, 0.2],
    [0.3, 0.6, 1],
    [1, 0.5, 0.5],
    [0.9, 0.75, 0.1],
  ] as [number, number, number][]
).map((rgbColor) =>
  BigInt(packColor(vec4FromVec3(vec3.fromValues(...rgbColor), 0.6))),
);
const MULTICUT_OFF_COLOR = vec4.fromValues(0, 0, 0, 0.5);
const WHITE_COLOR = vec3.fromValues(1, 1, 1);
// Trace candidates get their own colour so they never read as pending merges,
// which are red.
const YELLOW_COLOR = vec3.fromValues(1, 1, 0);

class CalcadaMeshSource extends WithParameters(
  WithSharedKvStoreContext(MeshSource),
  MeshSourceParameters,
) {
  // Live branch value shared with the backend counterpart. parameters.branchId
  // only captures the branch at datasource-creation time; switching branches
  // via the Graph-tab dropdown mutates CalcadaState.branchId on the same
  // datasource, and manifest requests must follow it or they resolve against
  // main and return empty piece lists for branch-only roots.
  private readonly liveBranchId: WatchableValueInterface<number> | undefined;

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.liveBranchId = options.branchId;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    if (this.liveBranchId !== undefined) {
      options.branchId = this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.liveBranchId),
      ).rpcId;
    }
    super.initializeCounterpart(rpc, options);
  }

  getFragmentKey(objectKey: string | null, fragmentId: string) {
    objectKey;
    return getCalcadaFragmentKey(fragmentId);
  }

  // Calcada mesh fragments are per-piece (the manifest lists "{piece_id}:0" per
  // piece). Opt into per-fragment picking so a 3D mesh pick resolves to the
  // clicked piece; the layer's equivalences then map that piece to its current
  // root, giving segmentSelectionState { baseValue: piece, value: root }. This
  // lets merge/split send the exact piece instead of a (possibly stale) root and
  // avoids the backend's surface-voxel resolution.
  get pickFragments(): boolean {
    return true;
  }

  // Each fragment is a distinct piece, so while a split tool is active (it sets
  // the transient displayState.highlightColor) the 3D mesh tints each piece by its
  // own id (piece boundaries become visible). Calcada-only; graphene keeps the
  // root colour.
  get colorFragmentsBySegment(): boolean {
    return true;
  }

  getFragmentPickId(fragmentId: string): bigint {
    // fragmentId is "{piece_id}:0" (":0" is the LOD suffix); take the piece id.
    // Piece ids are always non-zero, so MeshLayer's `getFragmentPickId(...) ||
    // objectId` fallback only fires when a fragment genuinely has no id.
    const colon = fragmentId.indexOf(":");
    return parseUint64(colon === -1 ? fragmentId : fragmentId.slice(0, colon));
  }
}

class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  l2CacheUrl: string;
  table: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle =
      /^((?:middleauth\+)?)(https?:\/\/[.\w:\-/]+)\/segmentation\/(?:1\.0|table)\/([^/]+)\/?$/;
    const match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.table = match[3];
    const { table } = this;
    this.segmentationUrl = `${match[1]}${match[2]}/segmentation/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.meshingUrl = `${match[1]}${match[2]}/meshing/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.l2CacheUrl = `${match[2]}/l2cache/api/v${PYCG_APP_VERSION}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
        obj,
        "supported_api_versions",
        (x) => parseArray(x, verifyNonnegativeInt),
      );
    } catch {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (this.supported_api_versions.includes(PYCG_APP_VERSION) === false) {
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${PYCG_APP_VERSION}, but the server only supports version(s) ${this.supported_api_versions}.`;
      throw new Error(redirectMsg);
    }
  }
}

const N_BITS_FOR_LAYER_ID_DEFAULT = 8;

class GraphInfo {
  chunkSize: vec3;
  nBitsForLayerId: number;
  constructor(obj: any) {
    verifyObject(obj);
    this.chunkSize = verifyObjectProperty(obj, "chunk_size", (x) =>
      parseFixedLengthArray(vec3.create(), x, verifyPositiveInt),
    );
    this.nBitsForLayerId = verifyOptionalObjectProperty(
      obj,
      "n_bits_for_layer_id",
      verifyPositiveInt,
      N_BITS_FOR_LAYER_ID_DEFAULT,
    );
  }
}

interface CalcadaMultiscaleVolumeInfo extends MultiscaleVolumeInfo {
  dataUrl: string;
  meshSourceUrl: string | undefined;
  app: AppInfo;
  graph: GraphInfo;
}

function parseCalcadaMultiscaleVolumeInfo(
  obj: unknown,
  url: string,
): CalcadaMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  const dataUrl = verifyObjectProperty(obj, "data_dir", verifyString);
  const meshSourceUrl = verifyObjectProperty(
    obj,
    "mesh_source_url",
    verifyOptionalString,
  );
  const app = verifyObjectProperty(obj, "app", (x) => new AppInfo(url, x));
  const graph = verifyObjectProperty(obj, "graph", (x) => new GraphInfo(x));
  return {
    ...volumeInfo,
    app,
    graph,
    dataUrl,
    meshSourceUrl,
  };
}

// Frontend chunk source that pairs with CalcadaVolumeChunkSource backend.
// Uses the calcada-specific RPC_ID ("calcada/VolumeChunkSource") so the
// backend can intercept downloads and extract the piece→root LUT trailer.
// This id MUST stay distinct from graphene's ("graphene/VolumeChunkSource"):
// both datasources register shared objects into one global last-write-wins
// map, so a shared id would make calcada silently shadow graphene (see the
// note in calcada/base.ts).
class CalcadaVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  CalcadaVolumeChunkSourceParameters,
) {}

class CalcadaMultiscaleVolumeChunkSource extends PrecomputedMultiscaleVolumeChunkSource {
  // URL for the /precomputed_rp/ endpoint (piece_ids + LUT trailer)
  private rpUrl: string;

  // Keeps chunk loading in sync with the "zoom in to load" message: beyond
  // this ratio the slice view stops requesting /precomputed_rp/ chunks.
  override renderRatioLimit = RENDER_RATIO_LIMIT;

  timestampMs = 0;
  branchId = 0;
  generation = 0;

  constructor(
    sharedKvStoreContext: SharedKvStoreContext,
    public info: CalcadaMultiscaleVolumeInfo,
  ) {
    super(sharedKvStoreContext, info.dataUrl, info);
    // Build /precomputed_rp/ URL from raw data URL
    this.rpUrl = info.dataUrl.replace("/precomputed", "/precomputed_rp");
  }

  // Override to use CalcadaVolumeChunkSource (with LUT trailer handling)
  // pointing to /precomputed_rp/ endpoint.
  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const { rank } = this;
    // Voxels are always requested from calcada _rp: for main + branch the
    // backend fetches the chunk from _rp, which 302-redirects to the public
    // bucket by default (resolving base vs per-branch overlay server-side),
    // plus a separate ?lut_only=true trailer fetch for the mapping;
    // time-travel keeps the bundled _rp?timestamp= path.
    return transposeNestedArrays(
      this.info.scales
        .filter((x) => !x.hidden)
        .filter((x) => x.key !== "placeholder")
        .map((scaleInfo) => {
          const { resolution } = scaleInfo;
          const stride = rank + 1;
          const chunkToMultiscaleTransform = new Float32Array(stride * stride);
          chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
          const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
            this.info.modelSpace.boundingBoxes[0].box;
          const lowerClipBound = new Float32Array(rank);
          const upperClipBound = new Float32Array(rank);
          for (let i = 0; i < 3; ++i) {
            const relativeScale = resolution[i] / modelResolution[i];
            chunkToMultiscaleTransform[stride * i + i] = relativeScale;
            const voxelOffsetValue = scaleInfo.voxelOffset[i];
            chunkToMultiscaleTransform[stride * rank + i] =
              voxelOffsetValue * relativeScale;
            lowerClipBound[i] =
              baseLowerBound[i] / relativeScale - voxelOffsetValue;
            upperClipBound[i] =
              baseUpperBound[i] / relativeScale - voxelOffsetValue;
          }
          return makeDefaultVolumeChunkSpecifications({
            rank,
            dataType: this.dataType,
            chunkToMultiscaleTransform,
            upperVoxelBound: scaleInfo.size,
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            baseVoxelOffset: scaleInfo.voxelOffset,
            compressedSegmentationBlockSize:
              scaleInfo.compressedSegmentationBlockSize,
            volumeSourceOptions,
          }).map(
            (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
              chunkSource: this.chunkManager.getChunkSource(
                CalcadaVolumeChunkSource,
                {
                  sharedKvStoreContext: this.sharedKvStoreContext,
                  spec,
                  parameters: {
                    url: kvstoreEnsureDirectoryPipelineUrl(
                      this.sharedKvStoreContext.kvStoreContext.resolveRelativePath(
                        this.rpUrl,
                        scaleInfo.key,
                      ),
                    ),
                    encoding: scaleInfo.encoding as number,
                    sharding: scaleInfo.sharding,
                    timestampMs: this.timestampMs,
                    branchId: this.branchId,
                    generation: this.generation,
                  },
                },
              ),
              chunkToMultiscaleTransform,
              lowerClipBound,
              upperClipBound,
            }),
          );
        }),
    );
  }

  getChunkedGraphSource() {
    const { rank } = this;
    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph.chunkSize),
      baseVoxelOffset: scaleInfo.voxelOffset,
    });

    const stride = rank + 1;
    const chunkToMultiscaleTransform = new Float32Array(stride * stride);
    chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
    const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
      this.info.modelSpace.boundingBoxes[0].box;
    const lowerClipBound = new Float32Array(rank);
    const upperClipBound = new Float32Array(rank);

    for (let i = 0; i < 3; ++i) {
      const relativeScale = 1;
      chunkToMultiscaleTransform[stride * i + i] = relativeScale;
      chunkToMultiscaleTransform[stride * rank + i] = scaleInfo.voxelOffset[i];
      lowerClipBound[i] = baseLowerBound[i];
      upperClipBound[i] = baseUpperBound[i];
    }
    return {
      chunkSource: this.chunkManager.getChunkSource(
        CalcadaChunkedGraphChunkSource,
        {
          spec,
          sharedKvStoreContext: this.sharedKvStoreContext,
          parameters: { url: `${this.info.app!.segmentationUrl}/node` },
        },
      ),
      chunkToMultiscaleTransform,
      lowerClipBound,
      upperClipBound,
    };
  }
}

function parseTransform(data: any): mat4 {
  return verifyObjectProperty(data, "transform", (value) => {
    const transform = mat4.create();
    if (value !== undefined) {
      parseFixedLengthArray(
        transform.subarray(0, 12),
        value,
        verifyFiniteFloat,
      );
    }
    mat4.transpose(transform, transform);
    return transform;
  });
}

interface ParsedMeshMetadata {
  metadata: MultiscaleMeshMetadata | undefined;
  segmentPropertyMap?: string | undefined;
}

function parseMeshMetadata(data: any): ParsedMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, "@type", verifyString);
  let metadata: MultiscaleMeshMetadata | undefined;
  if (t === "neuroglancer_legacy_mesh") {
    metadata = undefined;
  } else if (t !== "neuroglancer_multilod_draco") {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  } else {
    const lodScaleMultiplier = verifyObjectProperty(
      data,
      "lod_scale_multiplier",
      verifyFinitePositiveFloat,
    );
    const vertexQuantizationBits = verifyObjectProperty(
      data,
      "vertex_quantization_bits",
      verifyPositiveInt,
    );
    const transform = parseTransform(data);
    const sharding = verifyObjectProperty(
      data,
      "sharding",
      parseShardingParameters,
    );
    metadata = {
      lodScaleMultiplier,
      transform,
      sharding,
      vertexQuantizationBits,
    };
  }
  const segmentPropertyMap = verifyObjectProperty(
    data,
    "segment_properties",
    verifyOptionalString,
  );
  return { metadata, segmentPropertyMap };
}

async function getMeshMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<ParsedMeshMetadata> {
  const metadata = await getJsonMetadata(
    sharedKvStoreContext,
    url,
    /*required=*/ false,
    options,
  );
  if (metadata === undefined) {
    // If the info file is missing, assume it is the legacy
    // single-resolution mesh format.
    return { metadata: undefined };
  }
  return parseMeshMetadata(metadata);
}

function parseShardingEncoding(y: any): DataEncoding {
  if (y === undefined) return DataEncoding.RAW;
  return verifyEnumString(y, DataEncoding);
}

function parseShardingParameters(
  shardingData: any,
): ShardingParameters | undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const t = verifyObjectProperty(shardingData, "@type", verifyString);
  if (t !== "neuroglancer_uint64_sharded_v1") {
    throw new Error(`Unsupported sharding format: ${JSON.stringify(t)}`);
  }
  const hash = verifyObjectProperty(shardingData, "hash", (y) =>
    verifyEnumString(y, ShardingHashFunction),
  );
  const preshiftBits = verifyObjectProperty(
    shardingData,
    "preshift_bits",
    verifyInt,
  );
  const shardBits = verifyObjectProperty(shardingData, "shard_bits", verifyInt);
  const minishardBits = verifyObjectProperty(
    shardingData,
    "minishard_bits",
    verifyInt,
  );
  const minishardIndexEncoding = verifyObjectProperty(
    shardingData,
    "minishard_index_encoding",
    parseShardingEncoding,
  );
  const dataEncoding = verifyObjectProperty(
    shardingData,
    "data_encoding",
    parseShardingEncoding,
  );
  return {
    hash,
    preshiftBits,
    shardBits,
    minishardBits,
    minishardIndexEncoding,
    dataEncoding,
  };
}

function getShardedMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  parameters: MeshSourceParameters,
  branchId: WatchableValueInterface<number>,
) {
  // branchId rides alongside the mixin-typed options; the CalcadaMeshSource
  // constructor picks it up, but the WithParameters options type doesn't know
  // about it, hence the cast.
  return sharedKvStoreContext.chunkManager.getChunkSource(CalcadaMeshSource, {
    sharedKvStoreContext,
    parameters,
    branchId,
  } as never);
}

async function getMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  fragmentUrl: string,
  nBitsForLayerId: number,
  branchId: WatchableValueInterface<number>,
  options: ProgressOptions,
) {
  const { metadata, segmentPropertyMap } = await getMeshMetadata(
    sharedKvStoreContext,
    fragmentUrl,
    options,
  );
  const parameters: MeshSourceParameters = {
    manifestUrl: url,
    fragmentUrl: fragmentUrl,
    // Only selects which manifest to fetch (see CalcadaMeshSource.download's
    // `/manifest/{objectId}:{lod}` path); the mesh detail level actually
    // rendered per piece is chosen dynamically in backend.ts's
    // downloadFragment via selectLodForPieceCount, not by this field.
    lod: 0,
    sharding: metadata?.sharding,
    vertexQuantizationBits: metadata?.vertexQuantizationBits ?? 16,
    nBitsForLayerId,
    branchId: branchId.value,
  };
  const transform = metadata?.transform || mat4.create();
  return {
    source: getShardedMeshSource(sharedKvStoreContext, parameters, branchId),
    transform,
    segmentPropertyMap,
  };
}

export function getJsonMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  required: boolean,
  options: Partial<ProgressOptions>,
): Promise<any> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "precomputed:metadata",
      url,
    },
    options,
    async (options) => {
      const infoUrl = pipelineUrlJoin(url, "info");
      using _span = new ProgressSpan(options.progressListener, {
        message: `Reading calcada metadata from ${infoUrl}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(infoUrl, {
        ...options,
        throwIfMissing: required,
      });
      if (response === undefined) return undefined;
      return await response.response.json();
    },
  );
}

function getSubsourceToModelSubspaceTransform(info: MultiscaleVolumeInfo) {
  const m = mat4.create();
  const resolution = info.scales[0].resolution;
  for (let i = 0; i < 3; ++i) {
    m[5 * i] = 1 / resolution[i];
  }
  return m;
}

async function getVolumeDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  metadata: any,
  options: ProgressOptions,
  stateJson: any,
): Promise<DataSource> {
  const info = parseCalcadaMultiscaleVolumeInfo(metadata, url);
  const volume = new CalcadaMultiscaleVolumeChunkSource(
    sharedKvStoreContext,
    info,
  );
  const state = new CalcadaState();
  if (stateJson) {
    state.restoreState(stateJson);
  }
  // Sync the restored branchId onto the chunk source BEFORE NG starts
  // fetching chunks — otherwise the first /precomputed_rp/ requests go
  // out with branch_id=0 (the chunkSource default) and the user sees
  // main's view until refreshChunkSources() fires on a later UI toggle.
  volume.branchId = state.branchId.value;
  const segmentationGraph = new CalcadaGraphSource(info, volume, state);
  const { modelSpace } = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { volume },
    },
    {
      id: "graph",
      default: true,
      subsource: { segmentationGraph },
    },
    {
      id: "bounds",
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
          modelSpace.bounds,
        ),
      },
    },
  ];
  if (info.segmentPropertyMap !== undefined) {
    const mapUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        info.segmentPropertyMap,
      ),
    );
    const metadata = await getJsonMetadata(
      sharedKvStoreContext,
      mapUrl,
      /*required=*/ true,
      options,
    );
    const segmentPropertyMap = getSegmentPropertyMap(metadata);
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap },
    });
  }
  if (info.mesh !== undefined) {
    // Read sharded mesh bytes straight from the public bucket when calcada
    // advertises it (mesh_source_url) — avoids the per-shard 302 redirect.
    // Falls back to the data_dir-relative path (calcada _rp) otherwise.
    const meshFragmentUrl = kvstoreEnsureDirectoryPipelineUrl(
      info.meshSourceUrl ??
        sharedKvStoreContext.kvStoreContext.resolveRelativePath(
          info.dataUrl,
          info.mesh,
        ),
    );
    const { source: meshSource, transform } = await getMeshSource(
      sharedKvStoreContext,
      info.app!.meshingUrl,
      meshFragmentUrl,
      info.graph.nBitsForLayerId,
      state.branchId,
      options,
    );
    const subsourceToModelSubspaceTransform =
      getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(
      subsourceToModelSubspaceTransform,
      subsourceToModelSubspaceTransform,
      transform,
    );
    subsources.push({
      id: "mesh",
      default: true,
      subsource: { mesh: meshSource },
      subsourceToModelSubspaceTransform,
    });
  }
  return {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources,
    state,
  };
}

// Note: Calcada is not really a kvstore-based data source, since it relies on
// making arbitrary HTTP requests rather than just kvstore. It fails if the
// provided kvstore does not inherit from HttpKvStore.
export class CalcadaDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "calcada";
  }
  get description() {
    return "Calcada data source";
  }

  get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult> {
    ensureEmptyUrlSuffix(options.url);
    const url = kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl);
    // Include options.state in the memoize key so two segmentation layers
    // sharing the same URL but different per-source state (e.g. main layer
    // with state={} and branch layer with state={calcadaBranch:N}) get
    // independent DataSource instances. Without this the second layer
    // silently reuses the first's CalcadaState/branchId and ignores its
    // restored state — the diff-link branch layer ends up showing "main".
    const stateKey = JSON.stringify(options.state ?? null);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "calcada:get", url, stateKey },
      options,
      async (progressOptions) => {
        const metadata = await getJsonMetadata(
          options.registry.sharedKvStoreContext,
          url,
          /*required=*/ true,
          progressOptions,
        );
        verifyObject(metadata);
        const redirect = verifyOptionalObjectProperty(
          metadata,
          "redirect",
          verifyString,
        );
        const canonicalUrl = `${options.url.scheme}://${url}`;
        if (redirect !== undefined) {
          return { canonicalUrl, targetUrl: redirect };
        }
        const t = verifyOptionalObjectProperty(metadata, "@type", verifyString);
        switch (t) {
          case "neuroglancer_multiscale_volume":
          case undefined: {
            const dataSource = await getVolumeDataSource(
              options.registry.sharedKvStoreContext,
              url,
              metadata,
              progressOptions,
              options.state,
            );
            dataSource.canonicalUrl = canonicalUrl;
            return dataSource;
          }
          default:
            throw new Error(`Invalid type: ${JSON.stringify(t)}`);
        }
      },
    );
  }
}

function getGraphLoadedSubsource(layer: SegmentationUserLayer) {
  for (const dataSource of layer.dataSources) {
    const { loadState } = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const subsource of loadState.subsources) {
      if (subsource.enabled && subsource.subsourceEntry.id === "graph") {
        return subsource;
      }
    }
  }
  return undefined;
}

function makeColoredAnnotationState(
  layer: SegmentationUserLayer,
  loadedSubsource: LoadedDataSubsource,
  subsubsourceId: string,
  color: vec3,
) {
  const { subsourceEntry } = loadedSubsource;
  const source = new LocalAnnotationSource(
    loadedSubsource.loadedDataSource.transform,
    new WatchableValue([]),
    ["associated segments"],
  );

  const displayState = new AnnotationDisplayState();
  displayState.color.value.set(color);

  displayState.relationshipStates.set("associated segments", {
    segmentationState: new WatchableValue(layer.displayState),
    showMatches: new TrackableBoolean(false),
  });

  const state = new AnnotationLayerState({
    localPosition: layer.localPosition,
    transform: loadedSubsource.getRenderLayerTransform(),
    source,
    displayState,
    dataSource: loadedSubsource.loadedDataSource.layerDataSource,
    subsourceIndex: loadedSubsource.subsourceIndex,
    subsourceId: subsourceEntry.id,
    subsubsourceId,
    role: RenderLayerRole.ANNOTATION,
  });
  layer.addAnnotationLayerState(state, loadedSubsource);
  return state;
}

function getOptionalUint64(obj: any, key: string) {
  return verifyOptionalObjectProperty(obj, key, parseUint64);
}

function getUint64(obj: any, key: string) {
  return verifyObjectProperty(obj, key, parseUint64);
}

function restoreSegmentSelection(obj: any): SegmentSelection {
  const segmentId = getUint64(obj, SEGMENT_ID_JSON_KEY);
  const rootId = getUint64(obj, ROOT_ID_JSON_KEY);
  const position = verifyObjectProperty(obj, POSITION_JSON_KEY, (value) => {
    return verify3dVec(value);
  });
  return {
    segmentId,
    rootId,
    position,
  };
}

const segmentSelectionToJSON = (x: SegmentSelection) => {
  return {
    [SEGMENT_ID_JSON_KEY]: x.segmentId.toString(),
    [ROOT_ID_JSON_KEY]: x.rootId.toString(),
    [POSITION_JSON_KEY]: [...x.position],
  };
};

const ID_JSON_KEY = "id";
const SEGMENT_ID_JSON_KEY = "segmentId";
const ROOT_ID_JSON_KEY = "rootId";
const POSITION_JSON_KEY = "position";
const SINK_JSON_KEY = "sink";
const SOURCE_JSON_KEY = "source";

const MULTICUT_JSON_KEY = "multicut";
const FOCUS_SEGMENT_JSON_KEY = "focusSegment";
const SINKS_JSON_KEY = "sinks";
const SOURCES_JSON_KEY = "sources";

const MERGE_JSON_KEY = "merge";
const MERGES_JSON_KEY = "merges";
const AUTOSUBMIT_JSON_KEY = "autosubmit";
const LOCKED_JSON_KEY = "locked";
const MERGED_ROOT_JSON_KEY = "mergedRoot";
const ERROR_JSON_KEY = "error";

const FIND_PATH_JSON_KEY = "findPath";
const TARGET_JSON_KEY = "target";
const CENTROIDS_JSON_KEY = "centroids";
const PRECISION_MODE_JSON_KEY = "precision";

const PIECE_SPLIT_JSON_KEY = "pieceSplit";
const ZETTA_TRACE_JSON_KEY = "zettaTrace";
const CALCADA_BRANCH_JSON_KEY = "calcadaBranch";

// CalcadaDebugTab is the layer's "Debug" tab: visible only while the
// piece-split tool's debug mode is active, it lists the debugged root's pieces
// with their overlay colours and per-piece mesh visibility — thin bridges
// between sub-pieces often run INSIDE a neighbouring piece's mesh, and hiding
// that piece is the only way to see them.
class CalcadaDebugTab extends Tab {
  constructor(private connection: GraphConnection) {
    super();
    this.element.classList.add("calcada-debug-tab");
    this.registerDisposer(
      connection.debugPiecesChanged.add(() => this.render()),
    );
    this.render();
  }

  private render() {
    const { element } = this;
    removeChildren(element);
    const colors = this.connection.debugPiecesColors;
    if (colors === undefined) {
      const hint = document.createElement("div");
      hint.className = "calcada-debug-tab-hint";
      hint.textContent =
        'Press "Debug" in the Piece split tool to inspect a segment\u2019s pieces here.';
      element.appendChild(hint);
      return;
    }
    const header = document.createElement("div");
    header.className = "calcada-debug-tab-hint";
    header.textContent =
      `Root ${this.connection.debugPiecesRoot?.toString() ?? "?"} \u2014 ` +
      `${colors.size} piece(s). Double-click a piece (in 3D or below) to ` +
      "hide/show its mesh.";
    element.appendChild(header);
    const list = document.createElement("div");
    list.className = "calcada-debug-piece-list";
    element.appendChild(list);
    for (const [piece, packedColor] of colors) {
      // Mirror the native segment-list row (same classes and widgets) so the
      // debug piece list reads exactly like the Seg. tab, with the eye wired
      // to per-piece mesh visibility instead of visibleSegments.
      const row = document.createElement("div");
      row.classList.add("neuroglancer-segment-list-entry");
      const sticky = document.createElement("div");
      sticky.classList.add("neuroglancer-segment-list-entry-sticky");
      row.appendChild(sticky);
      const copyContainer = document.createElement("div");
      copyContainer.classList.add(
        "neuroglancer-segment-list-entry-copy-container",
      );
      const copyButton = makeCopyButton({
        title: "Copy piece ID",
        onClick: (copyEvent) => {
          copyEvent.stopPropagation();
          setClipboard(piece.toString());
        },
      });
      copyButton.classList.add("neuroglancer-segment-list-entry-copy");
      copyContainer.appendChild(copyButton);
      sticky.appendChild(copyContainer);
      const hidden = this.connection.pieceMeshHidden(piece);
      const eye = makeEyeButton({
        title: hidden
          ? "Show this piece's mesh"
          : "Hide this piece's mesh (reveals bridges behind it)",
        onClick: (eyeEvent) => {
          eyeEvent.stopPropagation();
          this.connection.togglePieceMesh(piece);
        },
      });
      eye.classList.add("neuroglancer-segment-list-entry-visible-checkbox");
      eye.classList.toggle("neuroglancer-visible", !hidden);
      sticky.appendChild(eye);
      const idContainer = document.createElement("div");
      idContainer.classList.add("neuroglancer-segment-list-entry-id-container");
      sticky.appendChild(idContainer);
      const idElement = document.createElement("div");
      idElement.classList.add("neuroglancer-segment-list-entry-id");
      idElement.textContent = piece.toString();
      // packColor packs (a<<24)|(b<<16)|(g<<8)|r — red is the LOW byte, the
      // same layout getBaseObjectColor decodes for stated colors.
      const packed = Number(packedColor);
      const r = packed & 0xff;
      const g = (packed >> 8) & 0xff;
      const b = (packed >> 16) & 0xff;
      const color = vec3.fromValues(r / 255, g / 255, b / 255);
      idElement.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
      idElement.style.color = useWhiteBackground(color) ? "white" : "black";
      idContainer.appendChild(idElement);
      row.addEventListener("dblclick", () =>
        this.connection.togglePieceMesh(piece),
      );
      list.appendChild(row);
    }
  }
}

class CalcadaState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  public multicutState = new MulticutState();
  public mergeState = new MergeState();
  public findPathState = new FindPathState();
  public pieceSplitState = new PieceSplitState();
  public zettaTraceState = new ZettaTraceState();
  public branchId = new TrackableValue<number>(0, (x) =>
    typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0,
  );

  constructor() {
    super();
    this.registerDisposer(
      this.multicutState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.mergeState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.findPathState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.pieceSplitState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.zettaTraceState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.branchId.changed.add(() => {
        this.changed.dispatch();
      }),
    );
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    this.multicutState.replaceSegments(oldValues, newValues);
    this.mergeState.replaceSegments(oldValues, newValues);
    this.findPathState.replaceSegments(oldValues, newValues);
    this.pieceSplitState.replaceSegments(oldValues, newValues);
    this.zettaTraceState.replaceSegments(oldValues, newValues);
  }

  reset() {
    this.multicutState.reset();
    this.mergeState.reset();
    this.findPathState.reset();
    this.pieceSplitState.reset();
    this.zettaTraceState.reset();
  }

  toJSON() {
    return {
      [MULTICUT_JSON_KEY]: this.multicutState.toJSON(),
      [MERGE_JSON_KEY]: this.mergeState.toJSON(),
      [FIND_PATH_JSON_KEY]: this.findPathState.toJSON(),
      [PIECE_SPLIT_JSON_KEY]: this.pieceSplitState.toJSON(),
      [ZETTA_TRACE_JSON_KEY]: this.zettaTraceState.toJSON(),
      [CALCADA_BRANCH_JSON_KEY]: this.branchId.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, MULTICUT_JSON_KEY, (value) => {
      this.multicutState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, MERGE_JSON_KEY, (value) => {
      this.mergeState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, FIND_PATH_JSON_KEY, (value) => {
      this.findPathState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_JSON_KEY, (value) => {
      this.pieceSplitState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, ZETTA_TRACE_JSON_KEY, (value) => {
      this.zettaTraceState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, CALCADA_BRANCH_JSON_KEY, (value) => {
      this.branchId.restoreState(value);
    });
  }
}

export interface SegmentSelection {
  segmentId: bigint;
  rootId: bigint;
  position: Float32Array;
  annotationReference?: AnnotationReference;
}

class MergeState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  merges = new WatchableValue<MergeSubmission[]>([]);
  autoSubmit = new TrackableBoolean(false);

  constructor() {
    super();
    this.registerDisposer(this.merges.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      merges: { value: merges },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    for (const merge of merges) {
      if (merge.source && oldValues.has(merge.source.rootId)) {
        if (newValue) {
          merge.source.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
      if (merge.sink && oldValues.has(merge.sink.rootId)) {
        if (newValue) {
          merge.sink.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
    }
  }

  reset() {
    this.merges.value = [];
    this.autoSubmit.reset();
  }

  toJSON() {
    const { merges, autoSubmit } = this;

    const mergeToJSON = (x: MergeSubmission) => {
      const res: any = {
        [ID_JSON_KEY]: x.id,
        [LOCKED_JSON_KEY]: x.locked,
        [SINK_JSON_KEY]: segmentSelectionToJSON(x.sink),
        [SOURCE_JSON_KEY]: segmentSelectionToJSON(x.source!),
      };
      if (x.mergedRoot) {
        res[MERGED_ROOT_JSON_KEY] = x.mergedRoot.toString();
      }
      if (x.error) {
        res[ERROR_JSON_KEY] = x.error;
      }
      return res;
    };
    return {
      [MERGES_JSON_KEY]: merges.value.filter((x) => x.source).map(mergeToJSON),
      [AUTOSUBMIT_JSON_KEY]: autoSubmit.toJSON(),
    };
  }

  restoreState(x: any) {
    function restoreSubmission(obj: any): MergeSubmission {
      const mergedRoot = getOptionalUint64(obj, MERGED_ROOT_JSON_KEY);
      const id = verifyObjectProperty(obj, ID_JSON_KEY, verifyString);
      const error = verifyOptionalObjectProperty(
        obj,
        ERROR_JSON_KEY,
        verifyString,
      );
      const locked = false; // TODO(chrisj) verifyObjectProperty(obj, LOCKED_JSON_KEY, verifyBoolean);
      const sink = restoreSegmentSelection(obj[SINK_JSON_KEY]);
      const source = restoreSegmentSelection(obj[SOURCE_JSON_KEY]);
      return {
        id,
        locked,
        sink,
        source,
        mergedRoot,
        error,
      };
    }

    const submissionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSubmission(x);
      });
    };

    this.merges.value = verifyObjectProperty(
      x,
      MERGES_JSON_KEY,
      submissionsValidator,
    );
    this.autoSubmit.restoreState(
      verifyOptionalObjectProperty(x, AUTOSUBMIT_JSON_KEY, verifyBoolean),
    );
  }
}

class FindPathState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  triggerPathUpdate = new NullarySignal();
  source = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  target = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  centroids = new TrackableValue<number[][]>([], (x) => x);
  precisionMode = new TrackableBoolean(true);

  constructor() {
    super();
    this.registerDisposer(
      this.source.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.target.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(this.centroids.changed.add(this.changed.dispatch));
  }

  get path() {
    const path: Line[] = [];
    const {
      source: { value: source },
      target: { value: target },
      centroids: { value: centroids },
    } = this;
    if (!source || !target || centroids.length === 0) {
      return path;
    }
    for (let i = 0; i < centroids.length - 1; i++) {
      const pointA = centroids[i];
      const pointB = centroids[i + 1];
      const line: Line = {
        pointA: vec3.fromValues(pointA[0], pointA[1], pointA[2]),
        pointB: vec3.fromValues(pointB[0], pointB[1], pointB[2]),
        id: "",
        type: AnnotationType.LINE,
        properties: [],
      };
      path.push(line);
    }
    const firstLine: Line = {
      pointA: source.position,
      pointB: path[0].pointA,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };
    const lastLine: Line = {
      pointA: path[path.length - 1].pointB,
      pointB: target.position,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };

    return [firstLine, ...path, lastLine];
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      source: { value: source },
      target: { value: target },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const sourceChanged = !!source && oldValues.has(source.rootId);
    const targetChanged = !!target && oldValues.has(target.rootId);
    if (newValue) {
      if (sourceChanged) {
        source.rootId = newValue;
      }
      if (targetChanged) {
        target.rootId = newValue;
      }
      // don't want to fire off multiple changed
      if (sourceChanged || targetChanged) {
        if (this.centroids.value.length) {
          this.centroids.reset();
          this.triggerPathUpdate.dispatch();
        } else {
          this.changed.dispatch();
        }
      }
    } else {
      if (sourceChanged || targetChanged) {
        this.reset();
      }
    }
  }

  reset() {
    this.source.reset();
    this.target.reset();
    this.centroids.reset();
    this.precisionMode.reset();
  }

  toJSON() {
    const {
      source: { value: source },
      target: { value: target },
      centroids,
      precisionMode,
    } = this;
    return {
      [SOURCE_JSON_KEY]: source ? segmentSelectionToJSON(source) : undefined,
      [TARGET_JSON_KEY]: target ? segmentSelectionToJSON(target) : undefined,
      [CENTROIDS_JSON_KEY]: centroids.toJSON(),
      [PRECISION_MODE_JSON_KEY]: precisionMode.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, SOURCE_JSON_KEY, (value) => {
      this.source.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, TARGET_JSON_KEY, (value) => {
      this.target.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, CENTROIDS_JSON_KEY, (value) => {
      this.centroids.restoreState(value);
    });
    verifyOptionalObjectProperty(x, PRECISION_MODE_JSON_KEY, (value) => {
      this.precisionMode.restoreState(value);
    });
  }
}

class MulticutState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  sinks = new WatchableSet<SegmentSelection>();
  sources = new WatchableSet<SegmentSelection>();

  constructor(
    public focusSegment = new TrackableValue<bigint | undefined>(
      undefined,
      (x) => x,
    ),
    public blueGroup = new WatchableValue<boolean>(false),
  ) {
    super();

    const maybeResetFocusSegemnt = () => {
      if (this.sinks.size === 0 && this.sources.size === 0) {
        this.focusSegment.value = undefined;
      }
    };

    this.registerDisposer(focusSegment.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(maybeResetFocusSegemnt));
    this.registerDisposer(this.sources.changed.add(maybeResetFocusSegemnt));

    this.registerDisposer(this.blueGroup.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sources.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const {
      focusSegment: { value: focusSegment },
    } = this;
    if (focusSegment && oldValues.has(focusSegment)) {
      if (newValue) {
        this.focusSegment.value = newValue;
        for (const sink of this.sinks) {
          sink.rootId = newValue;
        }
        for (const source of this.sources) {
          source.rootId = newValue;
        }
        this.changed.dispatch();
      } else {
        this.reset();
      }
    }
  }

  reset() {
    this.focusSegment.reset();
    this.blueGroup.value = false;
    this.sinks.clear();
    this.sources.clear();
  }

  toJSON() {
    const { focusSegment, sinks, sources } = this;
    return {
      [FOCUS_SEGMENT_JSON_KEY]: focusSegment.toJSON()?.toString(),
      [SINKS_JSON_KEY]: [...sinks].map(segmentSelectionToJSON),
      [SOURCES_JSON_KEY]: [...sources].map(segmentSelectionToJSON),
    };
  }

  restoreState(x: any) {
    const segmentSelectionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSegmentSelection(x);
      });
    };

    verifyOptionalObjectProperty(x, FOCUS_SEGMENT_JSON_KEY, (value) => {
      this.focusSegment.restoreState(parseUint64(value));
    });
    const sinks = verifyObjectProperty(
      x,
      SINKS_JSON_KEY,
      segmentSelectionsValidator,
    );
    const sources = verifyObjectProperty(
      x,
      SOURCES_JSON_KEY,
      segmentSelectionsValidator,
    );

    for (const sink of sinks) {
      this.sinks.add(sink);
    }

    for (const source of sources) {
      this.sources.add(source);
    }
  }

  swapGroup() {
    this.blueGroup.value = !this.blueGroup.value;
  }

  get activeGroup() {
    return this.blueGroup.value ? this.sources : this.sinks;
  }

  // following three functions are used to render multicut pieces in 2d (color them red/blue)
  get segments() {
    return [...this.redSegments, ...this.blueSegments];
  }

  get redSegments() {
    return [...this.sinks]
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }

  get blueSegments() {
    return [...this.sources]
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }
}

// VoxelPoint is an integer voxel coordinate placed by the user during piece
// split. We keep these in voxel-space (after the nm → voxel conversion using
// the graph's resolution) because the backend operates in voxel-space.
type VoxelPoint = [number, number, number];

// PointEntry stores both the voxel-space integer coordinate (used in the POST
// body) and the layer-space float coordinate (used for the 3D annotation
// marker shown in the viewer). The layer-space form is also persisted to JSON
// so reloads keep the markers exactly where they were placed.
interface PointEntry {
  voxel: VoxelPoint;
  layer: [number, number, number];
  // The piece (super-voxel) the point was placed on, and whether it was placed
  // in a 2D cross-section (exact voxel) or a 3D mesh view (backend snaps to the
  // nearest in-piece voxel).
  pieceId: bigint;
  origin: "2d" | "3d";
}

const PIECE_SPLIT_BLUE_KEY = "blue";
const PIECE_SPLIT_RED_KEY = "red";
const PIECE_SPLIT_USE_IMAGE_KEY = "useImage";

// PieceSplitState holds the working state of the point-driven piece split tool:
// the two coloured point lists and the active colour. The focused segment is not
// held here — it is derived from the points' current root when needed, so it can
// never go stale against the graph.
class PieceSplitState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  blueGroup = new WatchableValue<boolean>(true);
  bluePoints = new WatchableValue<PointEntry[]>([]);
  redPoints = new WatchableValue<PointEntry[]>([]);
  // Price the cut from the EM image (dark membranes cheap to cut). Off by
  // default: the image volume is then never read, which makes the split
  // several seconds faster; the cut runs on geometry and the data term alone.
  useImage = new WatchableValue<boolean>(false);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.blueGroup.changed.add(reemit));
    this.registerDisposer(this.bluePoints.changed.add(reemit));
    this.registerDisposer(this.redPoints.changed.add(reemit));
    this.registerDisposer(this.useImage.changed.add(reemit));
  }

  reset() {
    this.blueGroup.value = true;
    this.bluePoints.value = [];
    this.redPoints.value = [];
  }

  swapGroup() {
    this.blueGroup.value = !this.blueGroup.value;
  }

  // Returns a *new* array — callers should not mutate the existing value array.
  addPoint(p: PointEntry) {
    if (this.blueGroup.value) {
      this.bluePoints.value = [...this.bluePoints.value, p];
    } else {
      this.redPoints.value = [...this.redPoints.value, p];
    }
  }

  removePoint(group: "blue" | "red", index: number) {
    const src = group === "blue" ? this.bluePoints : this.redPoints;
    if (index < 0 || index >= src.value.length) return;
    const next = [...src.value];
    next.splice(index, 1);
    src.value = next;
    // Removing the last point releases the focus segment implicitly: with no
    // points left there is nothing to derive a focus from.
  }

  // replaceSegments mirrors the contract of MulticutState.replaceSegments. Points
  // are voxel-space and their pieces outlive a re-rooting, and the focus is
  // derived from them rather than stored, so an external merge or split needs no
  // fixup here — the focus follows the segment on its own.
  replaceSegments(_oldValues: Uint64Set, _newValues: Uint64Set) {}

  toJSON() {
    return {
      [PIECE_SPLIT_BLUE_KEY]: this.bluePoints.value.map(entryToJSON),
      [PIECE_SPLIT_RED_KEY]: this.redPoints.value.map(entryToJSON),
      [PIECE_SPLIT_USE_IMAGE_KEY]: this.useImage.value ? true : undefined,
    };
  }

  restoreState(x: any) {
    // A "focusRootId" from an older state is intentionally ignored: it is now
    // derived from the points.
    verifyOptionalObjectProperty(x, PIECE_SPLIT_BLUE_KEY, (value) => {
      this.bluePoints.value = parseArray(value, parseEntry);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_RED_KEY, (value) => {
      this.redPoints.value = parseArray(value, parseEntry);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_USE_IMAGE_KEY, (value) => {
      this.useImage.value = verifyBoolean(value);
    });
  }
}

const TRACE_ACTIVE_KEY = "active";
const TRACE_SEED_KEY = "seedRoot";
const TRACE_MIN_PIECE_VOXELS_KEY = "minPieceVoxels";
const TRACE_REJECTED_BY_KEY = "rejectedBy";
// Server-side alias for the authenticated user.
const TRACE_CURRENT_USER = "me";

/**
 * Zetta Trace is a mode, not a tool: a proofreader stays in it while switching
 * to merge or cut and back, so its state cannot live in a tool activation,
 * which neuroglancer tears down the moment another tool takes the single
 * active-tool slot.
 *
 * Only the durable knobs live here, and they are what a shared link restores.
 * The candidate list is deliberately not among them — it is refetched, because
 * a list saved minutes ago describes a graph that has since been edited.
 */
class ZettaTraceState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  active = new WatchableValue<boolean>(false);
  seedRoot = new WatchableValue<bigint | undefined>(undefined);
  // Candidates whose partner piece is smaller than this are debris the model
  // still scores highly. Zero offers everything.
  minPieceVoxels = new WatchableValue<number>(0);
  // Whose rejections to honour. Empty means anyone's. The literal "me" is
  // resolved by the server, which knows who the request is from — the browser
  // never learns its own user id.
  rejectedBy = new WatchableValue<string[]>([]);

  // Fires when a merge or a split has rewritten roots. The seed and the
  // candidate are identified by piece from here on: their root ids have just
  // changed, so anything holding a root id is stale.
  graphEdited = new Signal<
    (oldRoots: Uint64Set, newRoots: Uint64Set) => void
  >();

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.active.changed.add(reemit));
    this.registerDisposer(this.seedRoot.changed.add(reemit));
    this.registerDisposer(this.minPieceVoxels.changed.add(reemit));
    this.registerDisposer(this.rejectedBy.changed.add(reemit));
  }

  reset() {
    this.active.value = false;
    this.seedRoot.value = undefined;
  }

  // The seed is re-resolved from its piece rather than remapped from the old
  // root set: a cut splits one root into several, so the set alone cannot say
  // which side the seed ended up on.
  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    if (this.active.value) this.graphEdited.dispatch(oldValues, newValues);
  }

  toJSON() {
    return {
      [TRACE_ACTIVE_KEY]: this.active.value ? true : undefined,
      [TRACE_SEED_KEY]: this.seedRoot.value?.toString(),
      [TRACE_MIN_PIECE_VOXELS_KEY]: this.minPieceVoxels.value || undefined,
      [TRACE_REJECTED_BY_KEY]: this.rejectedBy.value.length
        ? this.rejectedBy.value
        : undefined,
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, TRACE_ACTIVE_KEY, (value) => {
      this.active.value = verifyBoolean(value);
    });
    verifyOptionalObjectProperty(x, TRACE_SEED_KEY, (value) => {
      this.seedRoot.value = BigInt(verifyString(value));
    });
    verifyOptionalObjectProperty(x, TRACE_MIN_PIECE_VOXELS_KEY, (value) => {
      this.minPieceVoxels.value = verifyInt(value);
    });
    verifyOptionalObjectProperty(x, TRACE_REJECTED_BY_KEY, (value) => {
      this.rejectedBy.value = parseArray(value, verifyString);
    });
  }
}

const VOXEL_KEY = "voxel";
const LAYER_KEY = "layer";

function entryToJSON(e: PointEntry) {
  return {
    [VOXEL_KEY]: e.voxel,
    [LAYER_KEY]: e.layer,
    piece_id: e.pieceId.toString(),
    origin: e.origin,
  };
}

function parseEntry(value: any): PointEntry {
  // Tolerate the older JSON shape that stored just a voxel triplet at the top
  // level — fall back to using it for both fields so reloads from earlier
  // sessions don't lose data.
  if (Array.isArray(value)) {
    const arr = parseFixedLengthArray(
      [0, 0, 0] as VoxelPoint,
      value,
      verifyInt,
    );
    return {
      voxel: arr,
      layer: [arr[0], arr[1], arr[2]],
      pieceId: 0n,
      origin: "2d",
    };
  }
  const voxel = verifyObjectProperty(value, VOXEL_KEY, (v) =>
    parseFixedLengthArray([0, 0, 0] as VoxelPoint, v, verifyInt),
  );
  const layer = verifyObjectProperty(value, LAYER_KEY, (v) =>
    parseFixedLengthArray(
      [0, 0, 0] as [number, number, number],
      v,
      verifyFiniteFloat,
    ),
  );
  let pieceId = 0n;
  if (value.piece_id !== undefined) {
    pieceId = parseUint64(value.piece_id);
  }
  const origin: "2d" | "3d" = value.origin === "3d" ? "3d" : "2d";
  return { voxel, layer, pieceId, origin };
}

const ZETTA_TRACE_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:arrowleft": { action: "reject-candidate" },
  "at:arrowright": { action: "accept-candidate" },
  "at:arrowdown": { action: "skip-candidate" },
  // Its own action name, not the shared "undo": the merge and cut tools listen
  // for that one on window, and a keypress resolving to it would run their
  // handler and this one both — two reverts from a single press.
  "at:control+keyz": { action: "trace-undo" },
  "at:meta+keyz": { action: "trace-undo" },
  // Seeding is deliberate and plain click is not: a proofreader checking
  // whether a candidate is right needs to select neighbouring segments to look
  // at, and that must not move the trace.
  "at:shift+mousedown0": { action: "set-trace-seed" },
  "at:escape": { action: "exit-trace" },
});

// A merge is not instantly visible to a read that lands on another replica, so
// the enlarged segment can come back empty for a moment. Asking the server for
// a consistent read fixes that but measures 10x slower on this dataset
// (1.2s -> 13s), which is unusable between swipes. Retrying an empty result
// costs nothing in the common case.
const EMPTY_RETRY_DELAYS_MS = [300, 700, 1500];

/**
 * Drives Zetta Trace: fetching candidates for the seed segment, drawing the
 * one under review, and applying the proofreader's verdict.
 *
 * This lives on the GraphConnection rather than in a tool because the trace has
 * to survive the user picking up the merge or cut tool mid-review — a tool
 * activation would be torn down at that moment, taking the seed and the
 * candidate list with it. The keys are bound for as long as the mode is on,
 * over whatever tool happens to be active.
 */
class ZettaTraceSession extends RefCounted {
  // The panel reads these; it re-renders on `changed`.
  readonly changed = new NullarySignal();
  status = "Shift+click a segment to seed the trace";
  current: EdgeCandidate | undefined;
  remaining = 0;

  // The seed's own piece. Root ids die on every merge and cut; this does not,
  // so it is what the trace re-resolves itself from afterwards.
  private seedPieceId: bigint | undefined;
  private candidates: EdgeCandidate[] = [];
  // Candidates accepted this session, newest last, so an undo can offer the top
  // one again.
  private acceptedLines: bigint[] = [];
  // Rejections and skips both land here so neither comes back this session.
  // Skips are memory-only by design: they mean "not now", and a proofreader
  // starting a fresh session should see them again.
  private decided = new Set<bigint>();
  private savedVisible: bigint[] = [];
  private savedSelected: bigint[] = [];
  // A merge is not instant, and a candidate that has not visibly changed
  // invites a second press that would submit the same merge twice.
  private busy = false;
  // Re-seeding while a fetch is in flight would otherwise let the older
  // response land last and repopulate the list for the previous segment.
  private fetchToken = 0;
  private annotationIds: string[] = [];
  // Guards against re-requesting the same partner's candidates every time the
  // panel re-renders the current one.
  private prefetchedPartner: bigint | undefined;
  private bindings: RefCounted | undefined;
  private modePanel: StatusMessage | undefined;
  private modePanelStatus: HTMLElement | undefined;
  // Role segments the proofreader toggled "off": they stay visible but faint
  // rather than disappearing, so the comparison never loses a side.
  private readonly dimmed = new Set<bigint>();
  // Roots this session's edits retired. Exiting must not put them back on
  // screen: they no longer exist in the graph, and the segment that replaced
  // them is already visible.
  private readonly retired = new Set<bigint>();
  private priorUseTempSegmentStatedColors2d = false;
  private reassertingRoleColors = false;

  constructor(
    private connection: GraphConnection,
    private layer: SegmentationUserLayer,
    private state: ZettaTraceState,
  ) {
    super();
    this.registerDisposer(
      state.active.changed.add(() => {
        if (state.active.value) {
          this.enter();
        } else {
          this.exit();
        }
      }),
    );
    this.registerDisposer(
      state.graphEdited.add((oldRoots, newRoots) =>
        this.onGraphEdited(oldRoots, newRoots),
      ),
    );
    const refetchOnFilterChange = () => {
      if (state.active.value) void this.loadCandidates();
    };
    this.registerDisposer(
      state.minPieceVoxels.changed.add(refetchOnFilterChange),
    );
    this.registerDisposer(state.rejectedBy.changed.add(refetchOnFilterChange));
    if (state.active.value) this.enter();
    this.registerDisposer(() => this.hideModePanel());
  }

  private get segmentsState() {
    return this.layer.displayState.segmentationGroupState.value;
  }

  private get graphServer() {
    return this.connection.graph.graphServer;
  }

  private get branchId() {
    return this.connection.graph.branchId.value;
  }

  private setStatus(text: string) {
    this.status = text;
    if (this.modePanelStatus !== undefined) {
      this.modePanelStatus.textContent = text;
    }
    this.changed.dispatch();
  }

  /**
   * The mode's own section in the status list, built the way a tool activation
   * builds one (makeToolActivationStatusMessage) — same header, body and
   * key-binding row as merge and cut, so the three read as one family. The mode
   * cannot use that helper directly: its activation releases the tool slot
   * immediately, and the section has to outlive it.
   */
  private showModePanel() {
    if (this.modePanel !== undefined) return;
    const message = new StatusMessage(false);
    message.element.classList.add(
      "neuroglancer-tool-status",
      "calcada-zetta-trace-mode",
    );

    const content = document.createElement("div");
    content.classList.add("neuroglancer-tool-status-content");
    message.element.appendChild(content);

    const headerContainer = document.createElement("div");
    headerContainer.classList.add("neuroglancer-tool-status-header-container");
    const header = document.createElement("div");
    header.classList.add("neuroglancer-tool-status-header");
    header.textContent = "Zetta trace";
    headerContainer.appendChild(header);
    content.appendChild(headerContainer);

    const body = document.createElement("div");
    body.classList.add("neuroglancer-tool-status-body", "calcada-tool-status");
    const status = document.createElement("span");
    status.className = "calcada-zetta-trace-status";
    status.textContent = this.status;
    body.appendChild(status);
    content.appendChild(body);

    const bindingHelp = document.createElement("div");
    bindingHelp.textContent = ZETTA_TRACE_INPUT_EVENT_MAP.describe();
    bindingHelp.classList.add("neuroglancer-tool-status-bindings");
    message.element.appendChild(bindingHelp);

    this.modePanel = message;
    this.modePanelStatus = status;
  }

  private hideModePanel() {
    this.modePanel?.dispose();
    this.modePanel = undefined;
    this.modePanelStatus = undefined;
  }

  enter() {
    if (this.bindings !== undefined) return;
    // Snapshot before the first mutation: restoring what the user was looking
    // at is this mode's exit contract.
    this.savedVisible = [...this.segmentsState.visibleSegments];
    this.savedSelected = [...this.segmentsState.selectedSegments];
    this.priorUseTempSegmentStatedColors2d =
      this.layer.displayState.useTempSegmentStatedColors2d.value;
    this.dimmed.clear();
    this.retired.clear();

    const bindings = new RefCounted();
    this.bindings = bindings;
    // The same binder a tool activation uses, but scoped to the mode, so the
    // keys keep working while merge or cut holds the active-tool slot. Arrows
    // therefore review candidates instead of panning until the mode ends.
    this.layer.toolBinder.globalBinder.inputEventMapBinder(
      ZETTA_TRACE_INPUT_EVENT_MAP,
      bindings,
    );
    // That binder only reaches the data panels, so the keys went dead the
    // moment focus moved to the side panel — a proofreader who had just
    // clicked a segment in the list had to click back onto the image before an
    // arrow did anything. A document-level binder covers the rest of the
    // viewer; it steps aside over a data panel so the two never both fire, and
    // KeyboardEventBinder already ignores keys typed into form fields.
    const documentKeys = bindings.registerDisposer(
      new KeyboardEventBinder(document, ZETTA_TRACE_INPUT_EVENT_MAP),
    );
    documentKeys.shouldIgnore = (event: KeyboardEvent) =>
      (event.target as HTMLElement | null)?.closest?.(
        ".neuroglancer-rendered-data-panel",
      ) != null;
    const bind = (action: string, handler: () => void) => {
      bindings.registerDisposer(
        registerActionListener(
          window,
          action,
          (event: ActionEvent<unknown>) => {
            event.stopPropagation();
            handler();
          },
        ),
      );
    };
    bind("reject-candidate", () => this.reject());
    bind("accept-candidate", () => void this.accept());
    bind("skip-candidate", () => this.skip());
    bind("trace-undo", () => void this.undoLast());
    bind("exit-trace", () => {
      this.state.active.value = false;
    });
    bind("set-trace-seed", () => this.seedFromMouse());

    // Toggling a role segment off would drop half the comparison. Put it back
    // and record it as dimmed instead, so it renders faint rather than gone.
    bindings.registerDisposer(
      this.segmentsState.visibleSegments.changed.add((ids, add) => {
        if (add !== false || ids === null) return;
        const seedRoot = this.state.seedRoot.value;
        if (seedRoot === undefined) return;
        const roleRoots = new Set<bigint>([seedRoot]);
        if (this.current !== undefined) {
          roleRoots.add(this.current.partnerRootId);
        }
        const removedIds = typeof ids === "bigint" ? [ids] : Array.from(ids);
        const removed = interceptedRemovals(removedIds, roleRoots).filter(
          // A root an edit retired is being removed because it no longer
          // exists, not because the proofreader hid it; putting it back would
          // leave an id on screen that renders nothing.
          (id) => !this.retired.has(id),
        );
        if (removed.length === 0) return;
        for (const id of removed) {
          // Toggle, not latch: hiding a dimmed role segment brings it back to
          // full strength — otherwise a second double-click did nothing.
          if (this.dimmed.has(id)) {
            this.dimmed.delete(id);
          } else {
            this.dimmed.add(id);
          }
          this.segmentsState.visibleSegments.add(id);
        }
        this.applyRoleColors(seedRoot, this.current?.partnerRootId);
      }),
    );

    // A graph tool activating (multicut, merge) resets the shared temp color
    // map for its own display, and the role colors vanish with it — pressing C
    // made the mode look like it had ended. Refill whatever went missing; a
    // tool that painted a role segment itself (the focus of a cut renders
    // transparent) keeps its own entry because refilling never overwrites.
    bindings.registerDisposer(
      this.layer.displayState.tempSegmentStatedColors2d.value.changed.add(() =>
        this.reassertRoleColors(),
      ),
    );
    bindings.registerDisposer(
      this.layer.displayState.useTempSegmentStatedColors2d.changed.add(() =>
        this.reassertRoleColors(),
      ),
    );

    this.showModePanel();
    this.revealSegmentsTab();
    if (this.state.seedRoot.value !== undefined) {
      void this.loadCandidates();
    } else {
      this.setStatus("Shift+click a segment to seed the trace");
    }
  }

  // The trace panel lives in the segments tab, so entering the mode from a
  // keybinding or a restored link would otherwise leave the proofreader looking
  // at a tab that says nothing about the trace they just started.
  private revealSegmentsTab() {
    for (const panel of this.layer.panels.panels) {
      if (panel.tabs.includes("segments")) {
        panel.selectedTab.value = "segments";
      }
    }
  }

  exit() {
    if (this.bindings === undefined) return;
    const candidateRoot = this.current?.partnerRootId;
    this.bindings.dispose();
    this.bindings = undefined;
    this.hideModePanel();
    this.clearAnnotation();
    this.candidates = [];
    this.current = undefined;
    this.decided.clear();
    this.acceptedLines.length = 0;
    this.prefetchedPartner = undefined;
    this.seedPieceId = undefined;
    ++this.fetchToken;

    // The seed does not outlive the mode: leaving means done with that segment.
    // Keeping it made re-entry snap the view back to the old candidate and wipe
    // whatever the proofreader had just selected to trace next.
    this.state.seedRoot.value = undefined;

    this.dimmed.clear();
    this.clearRoleColors();

    // Leaving keeps what the review built rather than rewinding to the entry
    // snapshot: the merged seed stays, and so does any segment pulled up for
    // context. Two things go: the candidate still under review, which was never
    // accepted, and every root this session's edits retired — those ids are
    // gone from the graph and restoring them would show segments that no longer
    // exist beside the one that replaced them.
    const { segmentsState } = this;
    const keep = (ids: Iterable<bigint>) => {
      const out = new Set<bigint>(ids);
      for (const id of this.retired) out.delete(id);
      if (candidateRoot !== undefined) out.delete(candidateRoot);
      return out;
    };
    const visible = keep([
      ...this.savedVisible,
      ...segmentsState.visibleSegments,
    ]);
    const selected = keep([
      ...this.savedSelected,
      ...segmentsState.selectedSegments,
    ]);
    segmentsState.visibleSegments.clear();
    segmentsState.selectedSegments.clear();
    for (const id of selected) segmentsState.selectedSegments.add(id);
    for (const id of visible) segmentsState.visibleSegments.add(id);
    this.setStatus("");
  }

  private clearAnnotation() {
    // Synchronous on purpose: a lingering line reads as backend latency.
    const { source } = this.connection.traceAnnotationState;
    for (const id of this.annotationIds.splice(0)) {
      source.delete(source.getReference(id));
    }
  }

  private seedFromMouse() {
    // Read the pick directly rather than through maybeGetSelection: showOnly has
    // reduced visibleSegments to the seed and the candidate, so that helper's
    // visibility gate would reject every third segment — exactly the ones a
    // proofreader re-seeds onto after reaching a dead end.
    const {
      segmentSelectionState: { value, baseValue },
    } = this.layer.displayState;
    if (!value || !baseValue) return;
    if (value === this.state.seedRoot.value) {
      StatusMessage.showTemporaryMessage("Already the seed", 3000);
      return;
    }
    this.setSeed(value, baseValue);
  }

  setSeed(rootId: bigint, pieceId?: bigint) {
    this.state.seedRoot.value = rootId;
    this.seedPieceId = pieceId;
    this.current = undefined;
    this.candidates = [];
    this.dimmed.clear();
    this.clearAnnotation();
    this.showOnly(rootId);
    void this.loadCandidates();
  }

  // Accepting or rejecting clears whatever the proofreader had selected for
  // context: the next candidate is a fresh question, and leaving the previous
  // comparison on screen is what made merges look like they had done nothing.
  private showOnly(seedRoot: bigint, candidateRoot?: bigint) {
    const { segmentsState } = this;
    segmentsState.visibleSegments.clear();
    segmentsState.selectedSegments.clear();
    segmentsState.visibleSegments.add(seedRoot);
    segmentsState.selectedSegments.add(seedRoot);
    if (candidateRoot !== undefined) {
      segmentsState.visibleSegments.add(candidateRoot);
      segmentsState.selectedSegments.add(candidateRoot);
    }
    this.applyRoleColors(seedRoot, candidateRoot);
  }

  // Blue seed, yellow candidate. Written into the temporary stated-color map
  // only: the persistent one serializes into the layer JSON and would leak
  // these role colors into shared links.
  private applyRoleColors(seedRoot: bigint, candidateRoot?: bigint) {
    const { displayState } = this.layer;
    this.reassertingRoleColors = true;
    try {
      const temp = displayState.tempSegmentStatedColors2d.value;
      temp.clear();
      temp.set(seedRoot, this.roleColor(seedRoot, "seed"));
      if (candidateRoot !== undefined) {
        temp.set(candidateRoot, this.roleColor(candidateRoot, "candidate"));
      }
      displayState.useTempSegmentStatedColors2d.value = true;
      displayState.honorTempStatedColorAlpha.value = true;
    } finally {
      this.reassertingRoleColors = false;
    }
  }

  private roleColor(rootId: bigint, role: "seed" | "candidate"): bigint {
    if (role === "seed") {
      return this.dimmed.has(rootId)
        ? TRACE_SEED_DIM_COLOR_PACKED
        : TRACE_SEED_COLOR_PACKED;
    }
    return this.dimmed.has(rootId)
      ? TRACE_CANDIDATE_DIM_COLOR_PACKED
      : TRACE_CANDIDATE_COLOR_PACKED;
  }

  // See the listener registration in enter(): puts the role colors back after
  // a tool activation resets the shared temp color map. Only fills entries
  // that are absent, so an active tool's own painting always wins.
  private reassertRoleColors() {
    if (this.reassertingRoleColors) return;
    if (!this.state.active.value) return;
    const seedRoot = this.state.seedRoot.value;
    if (seedRoot === undefined) return;
    const { displayState } = this.layer;
    const temp = displayState.tempSegmentStatedColors2d.value;
    const candidateRoot = this.current?.partnerRootId;
    const seedMissing = !temp.has(seedRoot);
    const candidateMissing =
      candidateRoot !== undefined && !temp.has(candidateRoot);
    if (
      !seedMissing &&
      !candidateMissing &&
      displayState.useTempSegmentStatedColors2d.value &&
      displayState.honorTempStatedColorAlpha.value
    ) {
      return;
    }
    this.reassertingRoleColors = true;
    try {
      if (seedMissing) {
        temp.set(seedRoot, this.roleColor(seedRoot, "seed"));
      }
      if (candidateRoot !== undefined && candidateMissing) {
        temp.set(candidateRoot, this.roleColor(candidateRoot, "candidate"));
      }
      displayState.useTempSegmentStatedColors2d.value = true;
      displayState.honorTempStatedColorAlpha.value = true;
    } finally {
      this.reassertingRoleColors = false;
    }
  }

  private clearRoleColors() {
    const { displayState } = this.layer;
    displayState.tempSegmentStatedColors2d.value.clear();
    displayState.useTempSegmentStatedColors2d.value =
      this.priorUseTempSegmentStatedColors2d;
    displayState.honorTempStatedColorAlpha.value = false;
  }

  private showCurrent() {
    this.clearAnnotation();
    const seedRoot = this.state.seedRoot.value;
    if (seedRoot === undefined) return;
    this.dimmed.clear();
    this.current = nextCandidate(this.candidates, this.decided);
    this.remaining = dropDecided(this.candidates, this.decided).length;
    if (this.current === undefined) {
      this.showOnly(seedRoot);
      this.setStatus("No candidates left for this segment");
      return;
    }
    const candidate = this.current;
    this.showOnly(seedRoot, candidate.partnerRootId);

    const line: Line = {
      id: "",
      type: AnnotationType.LINE,
      pointA: vec3.fromValues(
        candidate.pointA[0],
        candidate.pointA[1],
        candidate.pointA[2],
      ),
      pointB: vec3.fromValues(
        candidate.pointB[0],
        candidate.pointB[1],
        candidate.pointB[2],
      ),
      // The source is built with one relationship ("associated segments"), so
      // every annotation must carry a matching relatedSegments entry or the add
      // throws while indexing it. Each side's root followed by its piece.
      relatedSegments: [
        BigUint64Array.of(
          seedRoot,
          candidate.selfPieceId,
          candidate.partnerRootId,
          candidate.partnerPieceId,
        ),
      ],
      properties: [],
    };
    const { source } = this.connection.traceAnnotationState;
    this.annotationIds.push(source.add(line, true).id);

    const midpoint = vec3.create();
    vec3.add(midpoint, line.pointA as vec3, line.pointB as vec3);
    vec3.scale(midpoint, midpoint, 0.5);
    // Assumes the layer's three dimensions are the global ones, which holds for
    // a calcada layer. Position.value ignores an array whose length does not
    // match the coordinate space rank, so on a higher-rank space this simply
    // does not move rather than moving somewhere wrong.
    this.layer.manager.root.globalPosition.value = Float32Array.from(midpoint);

    this.setStatus(
      `score ${candidate.score.toFixed(2)} · ${candidate.nInterfaces} interface(s)` +
        ` · partner ${candidate.partnerRootId} · ${this.remaining} left`,
    );
    this.prefetchNext(candidate);
  }

  /**
   * Warm what either answer will need, while the proofreader is still deciding.
   *
   * Both outcomes are knowable now: rejecting shows the next candidate in the
   * list, and accepting continues from the merged segment, whose candidates
   * include the partner's own. Fetching each ahead of time turns the wait after
   * a keypress into no wait at all.
   *
   * Deliberately fire-and-forget: a prefetch that fails costs nothing, because
   * the real path re-requests anyway.
   */
  private prefetchNext(current: EdgeCandidate) {
    // The reject branch: the mesh of whichever candidate comes next.
    const decidedAfterThis = new Set(this.decided);
    decidedAfterThis.add(current.lineId);
    const next = nextCandidate(this.candidates, decidedAfterThis);
    if (next !== undefined) {
      this.connection.meshPrefetchSegments([next.partnerRootId]);
    }

    // The accept branch cannot be prefetched by url: the merged root does not
    // exist until the merge returns, so the post-merge request asks about an id
    // nothing can know yet. What this warms instead is the server's read of the
    // partner's pieces — the merged root contains them, so the same rows are on
    // the path of the query that follows. A cache keyed on the root id in the
    // path would not be hit; this is worth its cost only for the row-level
    // caching underneath.
    if (this.prefetchedPartner === current.partnerRootId) return;
    this.prefetchedPartner = current.partnerRootId;
    void this.graphServer
      .fetchCandidates(current.partnerRootId, {
        batch: DEFAULT_CANDIDATE_BATCH,
        limit: CANDIDATE_FETCH_LIMIT,
        minPieceVoxels: this.state.minPieceVoxels.value,
        rejectedBy: this.state.rejectedBy.value,
        branchId: this.branchId,
        priority: "low",
      })
      .catch(() => undefined);
  }

  private fetchOnce(seedRoot: bigint) {
    return this.graphServer.fetchCandidates(seedRoot, {
      batch: DEFAULT_CANDIDATE_BATCH,
      limit: CANDIDATE_FETCH_LIMIT,
      minPieceVoxels: this.state.minPieceVoxels.value,
      rejectedBy: this.state.rejectedBy.value,
      branchId: this.branchId,
    });
  }

  private async loadCandidates(retryWhenEmpty = false) {
    const seedRoot = this.state.seedRoot.value;
    if (seedRoot === undefined) return;
    const token = ++this.fetchToken;
    this.setStatus("Fetching candidates…");

    let fetched: EdgeCandidate[];
    try {
      fetched = await this.fetchOnce(seedRoot);
    } catch (e) {
      if (token === this.fetchToken) {
        this.setStatus(`Failed to fetch candidates: ${e}`);
      }
      return;
    }
    if (token !== this.fetchToken) return;

    if (fetched.length === 0 && retryWhenEmpty) {
      for (const delay of EMPTY_RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (token !== this.fetchToken) return;
        fetched = await this.fetchOnce(seedRoot).catch(
          () => [] as EdgeCandidate[],
        );
        if (token !== this.fetchToken) return;
        if (fetched.length > 0) break;
      }
    }

    this.candidates = fetched;
    this.showCurrent();
  }

  reject() {
    if (this.busy || this.current === undefined) return;
    const rejected = this.current;
    this.decided.add(rejected.lineId);
    this.showCurrent();
    this.graphServer
      .postCandidateDecision(
        rejected.lineId,
        "reject",
        undefined,
        this.branchId,
      )
      .catch((e: unknown) => {
        StatusMessage.showTemporaryMessage(
          `Failed to record rejection: ${e}`,
          5000,
        );
      });
  }

  // A skip is this session's business only — nothing is written, and exiting
  // the mode forgets it.
  skip() {
    if (this.busy || this.current === undefined) return;
    this.decided.add(this.current.lineId);
    this.showCurrent();
  }

  async accept() {
    const seedRoot = this.state.seedRoot.value;
    if (this.busy || this.current === undefined || seedRoot === undefined) {
      return;
    }
    const accepted = this.current;
    this.setBusy(true);
    this.clearAnnotation();
    this.setStatus("Merging…");

    let merged: bigint;
    try {
      merged = await this.connection.mergeSelections(
        {
          rootId: seedRoot,
          segmentId: accepted.selfPieceId,
          position: accepted.pointA,
        },
        {
          rootId: accepted.partnerRootId,
          segmentId: accepted.partnerPieceId,
          position: accepted.pointB,
        },
      );
    } catch (e) {
      // The candidate stays current so the right arrow retries it; a locked
      // root usually frees up within seconds.
      this.setStatus(`Merge failed: ${e}`);
      this.setBusy(false);
      return;
    }
    this.decided.add(accepted.lineId);
    this.acceptedLines.push(accepted.lineId);
    this.state.seedRoot.value = merged;
    this.showOnly(merged);

    this.graphServer
      .postCandidateDecision(
        accepted.lineId,
        "accept",
        // submitMerge returns only the new root, so the operation id the
        // decision could be tied to is not available here.
        undefined,
        this.branchId,
      )
      .catch((e: unknown) => {
        StatusMessage.showTemporaryMessage(
          `Failed to record acceptance: ${e}`,
          5000,
        );
      });

    // The merge we just issued must be visible, or the enlarged segment reads
    // back as having run out of candidates.
    await this.loadCandidates(true);
    this.setBusy(false);
  }

  private setBusy(value: boolean) {
    this.busy = value;
    this.changed.dispatch();
  }

  get isBusy() {
    return this.busy;
  }

  // A read that comes back as one of the roots the edit just retired is a
  // lagging replica, not an answer. Retry on the same ladder the empty-candidate
  // refetch uses.
  private async getRootRetrying(pieceId: bigint, oldRoots: Uint64Set) {
    const retired = new Set<bigint>(oldRoots);
    let resolved = await this.graphServer.getRoot(pieceId, 0, this.branchId);
    for (const delayMs of EMPTY_RETRY_DELAYS_MS) {
      if (!isStaleRoot(resolved, retired)) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      resolved = await this.graphServer.getRoot(pieceId, 0, this.branchId);
    }
    return resolved;
  }

  /**
   * Re-resolve the trace after someone edited the graph — a manual merge, or a
   * cut of the candidate segment, which is the workflow when a candidate turns
   * out to contain a merger. Both the seed and the partner get new root ids, so
   * the trace follows their pieces, which survive re-rooting.
   */
  private async onGraphEdited(oldRoots: Uint64Set, newRoots: Uint64Set) {
    if (this.bindings === undefined || this.busy) return;
    for (const id of oldRoots) {
      if (!newRoots.has(id)) this.retired.add(id);
    }
    await this.refreshFromSeedPiece(oldRoots, newRoots);
  }

  /**
   * Take back the last graph edit and put its candidate back on the table.
   *
   * Undo is graph-wide, not trace-local: control+Z takes back whatever was
   * edited last, which is what a proofreader who just made a mistake expects.
   * The candidate popped here is therefore the trace's last accept, which is the
   * same thing only when the accept was also the last edit — the common case,
   * and an over-eager offer is cheaper than a candidate that can never be
   * revisited.
   */
  async undoLast() {
    if (this.bindings === undefined || this.busy) return;
    this.setBusy(true);
    this.setStatus("Undoing…");
    try {
      // Only forget an accept when something actually reverted. An empty undo
      // stack and a failed revert both leave the graph as it was, and popping
      // then would re-offer a candidate whose merge is still in place while
      // quietly draining the list.
      if (await this.connection.undo()) {
        const lastAccepted = this.acceptedLines.pop();
        if (lastAccepted !== undefined) this.decided.delete(lastAccepted);
      }
    } finally {
      // Undo does not carry the retired root set the way a graph edit
      // notification does, so there is nothing to retry a stale read
      // against here.
      await this.refreshFromSeedPiece(new Uint64Set());
      this.setBusy(false);
    }
  }

  private async refreshFromSeedPiece(
    oldRoots: Uint64Set,
    newRoots?: Uint64Set,
  ) {
    // piece -> root reads go through a materialized view that lags an edit by
    // a moment, so a merge can keep answering with a root it just retired even
    // after getRootRetrying has exhausted its retries. Showing that id renders
    // nothing: both originals are gone and the segment that replaced them was
    // never made visible. When the edit produced exactly one root — every
    // merge — that root is the answer the lookup is failing to give.
    const replacement =
      newRoots !== undefined && newRoots.size === 1
        ? [...newRoots][0]
        : undefined;
    const retiredByEdit = new Set<bigint>(oldRoots);
    // An edit is not a reason to throw away what the proofreader has on screen.
    // showOnly() is for deliberate resets (seeding, accepting, rejecting); here
    // the view is reconciled instead: drop the roots this edit retired, show
    // the roots it created, keep everything else, and make sure the role
    // segments are present.
    const reconcile = (seed: bigint, candidate?: bigint) => {
      const { segmentsState } = this;
      for (const id of oldRoots) {
        if (newRoots !== undefined && newRoots.has(id)) continue;
        segmentsState.visibleSegments.delete(id);
        segmentsState.selectedSegments.delete(id);
      }
      for (const id of newRoots ?? []) {
        segmentsState.visibleSegments.add(id);
        segmentsState.selectedSegments.add(id);
      }
      for (const id of candidate === undefined ? [seed] : [seed, candidate]) {
        segmentsState.visibleSegments.add(id);
        segmentsState.selectedSegments.add(id);
      }
      this.applyRoleColors(seed, candidate);
    };
    const resolveRoot = async (pieceId: bigint) => {
      const resolved = await this.getRootRetrying(pieceId, oldRoots);
      return replacement !== undefined && isStaleRoot(resolved, retiredByEdit)
        ? replacement
        : resolved;
    };
    // Prefer the seed's own piece; the candidate's is the fallback for a trace
    // restored from a link, which carries no piece.
    const seedPiece = this.seedPieceId ?? this.current?.selfPieceId;
    const seedRoot = this.state.seedRoot.value;
    if (seedRoot === undefined) return;
    const token = ++this.fetchToken;
    this.setStatus("Refreshing after edit…");
    try {
      // Resolving the seed's own piece is what makes a cut safe: whichever side
      // of the cut that piece landed on is the segment the proofreader is on.
      if (seedPiece !== undefined) {
        const resolved = await resolveRoot(seedPiece);
        if (token !== this.fetchToken) return;
        this.state.seedRoot.value = resolved;
      }
    } catch (e) {
      this.setStatus(`Failed to re-resolve the seed: ${e}`);
      return;
    }
    if (token !== this.fetchToken) return;
    const resolvedSeedRoot = this.state.seedRoot.value!;

    // An edit that only re-rooted the candidate under review is not a reason to
    // throw away the review queue: follow the partner's piece and redraw in
    // place, so the proofreader keeps their position.
    if (this.current !== undefined) {
      let newPartnerRoot: bigint;
      try {
        newPartnerRoot = await resolveRoot(this.current.partnerPieceId);
      } catch (e) {
        this.setStatus(`Failed to re-resolve the candidate: ${e}`);
        return;
      }
      if (token !== this.fetchToken) return;
      const outcome = classifyCandidateEdit(
        resolvedSeedRoot !== seedRoot,
        resolvedSeedRoot,
        newPartnerRoot,
      );
      if (outcome === "rerooted") {
        this.current = { ...this.current, partnerRootId: newPartnerRoot };
        reconcile(resolvedSeedRoot, newPartnerRoot);
        this.setStatus(`partner ${newPartnerRoot} · ${this.remaining} left`);
        return;
      }
      if (outcome === "absorbed") {
        this.decided.add(this.current.lineId);
      }
    }
    this.current = undefined;
    this.clearAnnotation();
    reconcile(resolvedSeedRoot);
    await this.loadCandidates(true);
  }
}

class GraphConnection extends SegmentationGraphSourceConnection {
  public annotationLayerStates: AnnotationLayerState[] = [];
  public mergeAnnotationState: AnnotationLayerState;
  public findPathAnnotationState: AnnotationLayerState;
  // Piece-split debug overlay: one line per edge among a root's pieces. Enabled
  // edges render neutral; zero-affinity sibling edges (the connections a piece
  // split creates to keep the segment whole) render green so they stand out.
  public debugEdgeAnnotationState!: AnnotationLayerState;
  public debugSiblingAnnotationState!: AnnotationLayerState;
  public traceAnnotationState!: AnnotationLayerState;
  public traceSession!: ZettaTraceSession;

  // Debug piece view shared between the piece-split tool (which enters/leaves
  // debug mode) and the layer's "Debug" tab (which lists the pieces and drives
  // per-piece mesh visibility).
  readonly debugPiecesChanged = new NullarySignal();
  readonly debugTabHidden = new WatchableValue<boolean>(true);
  debugPiecesRoot: bigint | undefined;
  debugPiecesColors: Map<bigint, bigint> | undefined;

  constructor(
    public graph: CalcadaGraphSource,
    private layer: SegmentationUserLayer,
    private chunkSource: CalcadaMultiscaleVolumeChunkSource,
    public state: CalcadaState,
  ) {
    super(graph, layer.displayState.segmentationGroupState.value);
    layer.tabs.add("calcada-debug", {
      label: "Debug",
      order: -20,
      getter: () => new CalcadaDebugTab(this),
      hidden: this.debugTabHidden,
    });
    // The side panel snapshots the layer's tab list before this
    // datasource-driven tab exists (nothing listens to tabs.optionsChanged),
    // and it only registers hidden-listeners for tabs it knew at init — so
    // pull the new tab into the panels now and re-render the tab bar on every
    // visibility flip ourselves.
    layer.panels.updateTabs();
    // The connection is created per subsource activation and disposed on
    // deactivation, while layer.tabs lives with the layer: without cleanup a
    // re-activation would re-add the tab (Option already defined) and leak
    // the visibility listener.
    this.registerDisposer(() => {
      layer.tabs.remove("calcada-debug");
      layer.panels.updateTabs();
    });
    this.registerDisposer(
      this.debugTabHidden.changed.add(() => {
        layer.panels.updateTabs();
        for (const panel of layer.panels.panels) {
          panel.tabsChanged.dispatch();
        }
      }),
    );
    const segmentsState = layer.displayState.segmentationGroupState.value;
    // Calcada floods equivalences with per-chunk piece→root LUT trailers
    // (millions of entries): opt in to the batched / worker-mirrored table
    // maintenance in EquivalencesHashMap. Datasources that don't set this
    // (graphene, local) keep the default immediate-update path.
    segmentsState.segmentEquivalences.largeEquivalencesExpected = true;
    this.previousVisibleSegmentCount = segmentsState.visibleSegments.size;
    segmentsState.selectedSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.selectedSegmentsChanged(segmentIds, add);
      },
    );
    segmentsState.visibleSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.visibleSegmentsChanged(segmentIds, add);
      },
    );
    const {
      annotationLayerStates,
      state: { multicutState, mergeState, findPathState },
    } = this;

    const { timestamp } = segmentsState;
    this.registerDisposer(
      timestamp.changed.add(async () => {
        const nonLatestRoots = await this.graph.graphServer.filterLatestRoots(
          [...segmentsState.selectedSegments],
          timestamp.value,
          true,
          this.graph.branchId.value,
        );
        segmentsState.selectedSegments.delete(nonLatestRoots);
        const unsetTimestamp = timestamp.value === undefined;
        if (unsetTimestamp) {
          const {
            focusSegment: { value: focusSegment },
          } = state.multicutState;
          if (focusSegment) {
            segmentsState.visibleSegments.add(focusSegment);
          }
        }
        this.refreshChunkSources();
      }),
    );

    this.registerDisposer(
      this.graph.branchId.changed.add(() => {
        // Drop selections + equivalences: piece IDs are branch-local, so
        // a selected piece from the previous branch may not exist in the
        // new one and triggers "piece not found" errors on getRoot.
        // refreshChunkSources re-populates equivalences from the new
        // branch's LUT trailers as chunks load.
        segmentsState.selectedSegments.clear();
        segmentsState.visibleSegments.clear();
        segmentsState.segmentEquivalences.clear();
        // Undo entries are branch-scoped operation ids; drop them so a Ctrl+Z
        // after switching branches can't revert an op on the wrong branch.
        this.undoStack.length = 0;
        this.refreshChunkSources();
      }),
    );

    const loadedSubsource = getGraphLoadedSubsource(layer)!;
    const redGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sinks",
      RED_COLOR,
    );
    const blueGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sources",
      BLUE_COLOR,
    );
    synchronizeAnnotationSource(multicutState.sinks, redGroup);
    synchronizeAnnotationSource(multicutState.sources, blueGroup);
    annotationLayerStates.push(redGroup, blueGroup);

    if (layer.tool.value instanceof MergeSegmentsPlaceLineTool) {
      layer.tool.value = undefined;
    }

    this.mergeAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      // Legacy id kept verbatim: it is a persisted subsource key, and
      // renaming it would orphan the merge annotations in saved NG states.
      "grapheneMerge",
      RED_COLOR,
    );

    this.debugEdgeAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "calcadaDebugEdges",
      WHITE_COLOR,
    );
    // Its own source, not the merge one. Anything added to the merge source is
    // turned into a pending merge submission by the childAdded handler below,
    // so borrowing it would both queue phantom merges and leave the lines
    // behind when the trace clears them.
    this.traceAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "calcadaTraceCandidate",
      YELLOW_COLOR,
    );
    this.debugSiblingAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "calcadaDebugSiblings",
      GREEN_COLOR,
    );

    {
      const { mergeState } = state;
      const { merges, autoSubmit } = mergeState;
      const { mergeAnnotationState } = this;
      const { visibleSegments } = segmentsState;

      // load merges from state
      for (const merge of merges.value) {
        mergeAnnotationState.source.add(mergeToLine(merge));
      }

      // initialize source changes
      mergeAnnotationState.source.childAdded.add((x) => {
        const annotation = x as Line;
        const relatedSegments = annotation.relatedSegments![0];
        const visibles = Array.from(relatedSegments, (x) =>
          visibleSegments.has(x),
        );
        if (visibles[0] === false) {
          setTimeout(() => {
            const { tool } = layer;
            if (tool.value instanceof MergeSegmentsPlaceLineTool) {
              tool.value.deactivate();
            }
          }, 0);
          StatusMessage.showTemporaryMessage("Cannot merge a hidden segment.");
        } else if (merges.value.length < MAX_MERGE_COUNT) {
          merges.value = [...merges.value, lineToSubmission(annotation, true)];
        } else {
          setTimeout(() => {
            const { tool } = layer;
            if (tool.value instanceof MergeSegmentsPlaceLineTool) {
              tool.value.deactivate();
            }
          }, 0);
          StatusMessage.showTemporaryMessage(
            `Maximum of ${MAX_MERGE_COUNT} simultanous merges allowed.`,
          );
        }
      });

      mergeAnnotationState.source.childCommitted.add((x) => {
        const ref = mergeAnnotationState.source.getReference(x);
        const annotation = ref.value as Line | undefined;
        if (annotation) {
          const relatedSegments = annotation.relatedSegments![0];
          if (relatedSegments.length < 4) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              `Cannot merge segment with itself.`,
            );
          }
          const visibles: boolean[] = Array.from(relatedSegments, (x) =>
            visibleSegments.has(x),
          );
          if (visibles[2] === false) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              `Cannot merge a hidden segment.`,
            );
          }
          const existingSubmission = merges.value.find((x) => x.id === ref.id);
          if (existingSubmission && !existingSubmission?.locked) {
            //  how would it be locked?
            const newSubmission = lineToSubmission(annotation, false);
            existingSubmission.sink = newSubmission.sink;
            existingSubmission.source = newSubmission.source;
            merges.changed.dispatch();
            if (autoSubmit.value) {
              this.bulkMerge([existingSubmission]);
            }
          }
        }
        ref.dispose();
      });
      mergeAnnotationState.source.childDeleted.add((id) => {
        let changed = false;
        const filtered = merges.value.filter((x) => {
          const keep = x.id !== id || x.locked;
          if (!keep) {
            changed = true;
          }
          return keep;
        });
        if (changed) {
          merges.value = filtered;
        }
      });
    }

    const findPathGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "findpath",
      WHITE_COLOR,
    );
    this.findPathAnnotationState = findPathGroup;
    findPathGroup.source.childDeleted.add((annotationId) => {
      if (
        findPathState.source.value?.annotationReference?.id === annotationId
      ) {
        findPathState.source.value = undefined;
      }
      if (
        findPathState.target.value?.annotationReference?.id === annotationId
      ) {
        findPathState.target.value = undefined;
      }
    });
    const findPathChanged = () => {
      const { path, source, target } = findPathState;
      const annotationSource = findPathGroup.source;
      if (source.value && !source.value.annotationReference) {
        addSelection(annotationSource, source.value, "find path source");
      }
      if (target.value && !target.value.annotationReference) {
        addSelection(annotationSource, target.value, "find path target");
      }
      for (const annotation of annotationSource) {
        if (
          annotation.id !== source.value?.annotationReference?.id &&
          annotation.id !== target.value?.annotationReference?.id
        ) {
          annotationSource.delete(annotationSource.getReference(annotation.id));
        }
      }
      for (const line of path) {
        // line.id = ''; // TODO, is it a bug that this is necessary? annotationMap is empty if I
        // step through it but logging shows it isn't empty
        annotationSource.add(line);
      }
    };
    this.registerDisposer(findPathState.changed.add(findPathChanged));

    // Piece-split annotations: blue + red point markers, kept in sync with the
    // VoxelPoint lists in state.pieceSplitState.
    const { pieceSplitState } = state;
    const pieceSplitBlueAnnotation = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "pieceSplitBlue",
      BLUE_COLOR,
    );
    const pieceSplitRedAnnotation = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "pieceSplitRed",
      RED_COLOR,
    );
    // Default marker rendering uses size=5px which is barely visible when the
    // viewer is zoomed in close to a slice — and the cross-section fade in
    // slice view further drops the alpha. Bump the size, force opaque interior,
    // and add a contrasting border so markers stand out at any zoom.
    const PIECE_SPLIT_POINT_SHADER = `
void main() {
  setPointMarkerSize(20.0);
  setPointMarkerBorderWidth(3.0);
  setColor(vec4(defaultColor(), 1.0));
  setPointMarkerBorderColor(vec4(1.0, 1.0, 1.0, 1.0));
}
`;
    pieceSplitBlueAnnotation.displayState.shader.value =
      PIECE_SPLIT_POINT_SHADER;
    pieceSplitRedAnnotation.displayState.shader.value =
      PIECE_SPLIT_POINT_SHADER;
    const syncPieceSplitAnnotations = (
      points: PointEntry[],
      state: AnnotationLayerState,
    ) => {
      const src = state.source;
      // Drop every existing annotation in the source, then re-add the current
      // points. Simpler than tracking per-point identity since the lists are
      // short (a handful of points).
      for (const a of [...src]) src.delete(src.getReference(a.id));
      for (const p of points) {
        const annotation: Point = {
          id: "",
          point: new Float32Array(p.layer),
          type: AnnotationType.POINT,
          properties: [],
          description: `(${p.voxel[0]}, ${p.voxel[1]}, ${p.voxel[2]})`,
        };
        src.add(annotation);
      }
    };
    this.registerDisposer(
      pieceSplitState.bluePoints.changed.add(() =>
        syncPieceSplitAnnotations(
          pieceSplitState.bluePoints.value,
          pieceSplitBlueAnnotation,
        ),
      ),
    );
    this.registerDisposer(
      pieceSplitState.redPoints.changed.add(() =>
        syncPieceSplitAnnotations(
          pieceSplitState.redPoints.value,
          pieceSplitRedAnnotation,
        ),
      ),
    );
    // Initial sync from restored state.
    syncPieceSplitAnnotations(
      pieceSplitState.bluePoints.value,
      pieceSplitBlueAnnotation,
    );
    syncPieceSplitAnnotations(
      pieceSplitState.redPoints.value,
      pieceSplitRedAnnotation,
    );

    this.registerDisposer(
      findPathState.triggerPathUpdate.add(() => {
        const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
        const annotationToNanometers =
          loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
            (x) => x / 1e-9,
          );
        this.submitFindPath(
          findPathState.precisionMode.value,
          annotationToNanometers,
        ).then((success) => {
          success;
        });
      }),
    );
    findPathChanged(); // initial state
    const updateEditTimestampLock = () => {
      if (segmentsState.timestamp.value === undefined) {
        if (
          multicutState.focusSegment.value ||
          mergeState.merges.value.length > 0
        ) {
          // remind me why want to add ourselves compared to keeping it empty
          // if it is non empty, calcada knows there is a tool locking it
          segmentsState.timestampOwner.add(layer.managedLayer.name);
        } else {
          segmentsState.timestampOwner.delete(layer.managedLayer.name);
        }
      }
    };
    this.registerDisposer(state.changed.add(updateEditTimestampLock));
    updateEditTimestampLock();

    this.traceSession = this.registerDisposer(
      new ZettaTraceSession(this, layer, state.zettaTraceState),
    );
  }

  private graphRenderLayer: SliceViewPanelChunkedGraphLayer | undefined;

  refreshChunkSources() {
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    this.chunkSource.timestampMs = segmentsState.timestamp.value ?? 0;
    this.chunkSource.branchId = this.graph.branchId.value;
    this.chunkSource.generation += 1;
    // Wipe equivalences from prior LUT trailers or unions persist across a time/branch switch.
    segmentsState.segmentEquivalences.clear();
    for (const renderLayer of this.layer.renderLayers) {
      if (renderLayer instanceof SliceViewRenderLayer) {
        // transform.changed is read-only on the interface; cast to reach the underlying NullarySignal.
        (renderLayer.transform.changed as unknown as NullarySignal).dispatch();
      }
    }
  }

  createRenderLayers(
    chunkManager: ChunkManager,
    displayState: SegmentationDisplayState3D,
    localPosition: WatchableValueInterface<Float32Array>,
  ): RenderLayer[] {
    this.graphRenderLayer = new SliceViewPanelChunkedGraphLayer(
      chunkManager,
      this.chunkSource.getChunkedGraphSource(),
      displayState,
      localPosition,
      this.graph.info.graph.nBitsForLayerId,
      this.graph.branchId,
    );
    return [this.graphRenderLayer];
  }

  private lastDeselectionMessage: StatusMessage | undefined;
  private lastDeselectionMessageExists = false;

  private previousVisibleSegmentCount: number;

  private visibleSegmentsChanged(segments: bigint[] | null, added: boolean) {
    const { segmentsState } = this;
    const { state } = this.graph;
    const {
      focusSegment: { value: focusSegment },
    } = state.multicutState;
    const { timestamp } = segmentsState;
    const unsetTimestamp = timestamp.value === undefined;
    if (
      unsetTimestamp &&
      focusSegment &&
      !segmentsState.visibleSegments.has(focusSegment)
    ) {
      if (segmentsState.selectedSegments.has(focusSegment)) {
        StatusMessage.showTemporaryMessage(
          `Can't hide active multicut segment.`,
          3000,
        );
      } else {
        StatusMessage.showTemporaryMessage(
          `Can't deselect active multicut segment.`,
          3000,
        );
      }
      segmentsState.visibleSegments.add(focusSegment);
      if (segments) {
        segments = segments.filter((segment) => segment !== focusSegment);
      }
    }
    if (segments === null) {
      // Don't clear equivalences — they come from LUT and must persist.
      StatusMessage.showTemporaryMessage(
        `Hid all ${this.previousVisibleSegmentCount} segment(s).`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      if (
        !added &&
        !isBaseSegmentId(segmentId, this.graph.info.graph.nBitsForLayerId)
      ) {
        // Don't call deleteSet — equivalences come from the LUT trailer
        // and must persist across select/deselect cycles.
        if (this.lastDeselectionMessage && this.lastDeselectionMessageExists) {
          this.lastDeselectionMessage.dispose();
          this.lastDeselectionMessageExists = false;
        }
        this.lastDeselectionMessage = StatusMessage.showMessage(`Hid segment.`);
        this.lastDeselectionMessageExists = true;
        setTimeout(() => {
          if (this.lastDeselectionMessageExists) {
            this.lastDeselectionMessage!.dispose();
            this.lastDeselectionMessageExists = false;
          }
        }, 2000);
      }
    }
    this.previousVisibleSegmentCount = segmentsState.visibleSegments.size;
  }

  private selectedSegmentsChanged(segments: bigint[] | null, added: boolean) {
    const { segmentsState } = this;
    if (segments === null) {
      const leafSegmentCount = this.segmentsState.selectedSegments.size;
      StatusMessage.showTemporaryMessage(
        `Deselected all ${leafSegmentCount} segment(s).`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      if (!added) continue;
      const nBits = this.graph.info.graph.nBitsForLayerId;
      const layerId = segmentId >> BigInt(64 - nBits);

      // Already a root (layer >= 2) — nothing to resolve
      if (layerId >= 2n) continue;

      const resolveAndReplace = (rootId: bigint) => {
        segmentsState.visibleSegments.add(rootId);
        segmentsState.selectedSegments.add(rootId);
        // Drop the source piece so the segment panel only lists the
        // resolved root. selectedSegments.delete cascades to
        // visibleSegments removal, but the volume shader resolves the
        // piece to its root via segmentEquivalences before consulting
        // visibleSegments — as long as root stays selected the voxel
        // still renders with the root's color.
        if (segmentId !== rootId) {
          segmentsState.selectedSegments.delete(segmentId);
        }
      };

      if (layerId === 1n) {
        this.graph
          .getRoot(segmentId, segmentsState.timestamp.value)
          .then(resolveAndReplace);
      } else {
        // Raw piece (layer 0) — check equivalences first, fallback to server
        const representative = segmentsState.segmentEquivalences.get(segmentId);
        if (representative !== segmentId) {
          resolveAndReplace(representative);
        } else {
          const pieceWithLayer =
            (segmentId & 0x00ffffffffffffffn) | (1n << 56n);
          this.graph
            .getRoot(pieceWithLayer, segmentsState.timestamp.value)
            .then((rootId) => {
              resolveAndReplace(rootId);
              segmentsState.segmentEquivalences.link(rootId, segmentId);
            });
        }
      }
    }
  }

  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
    include;
    exclude;
    return undefined;
  }

  getMeshSource() {
    const { layer } = this;
    for (const dataSource of layer.dataSources) {
      const { loadState } = dataSource;
      if (loadState instanceof LoadedLayerDataSource) {
        const { subsources } = loadState.dataSource;
        const graphSubsource = subsources.filter(
          (subsource) => subsource.id === "graph",
        )[0];
        if (graphSubsource && graphSubsource.subsource.segmentationGraph) {
          if (graphSubsource.subsource.segmentationGraph !== this.graph) {
            continue;
          }
        }
        const meshSubsource = subsources.filter(
          (subsource) => subsource.id === "mesh",
        )[0];
        if (meshSubsource) {
          return meshSubsource.subsource.mesh;
        }
      }
    }
    return undefined;
  }

  private splitModeActive = false;
  private splitModeGeneration = 0;

  async enterSplitMode(focusSegment: bigint) {
    if (this.splitModeActive) return;
    this.splitModeActive = true;
    const generation = ++this.splitModeGeneration;
    try {
      const segmentsState =
        this.layer.displayState.segmentationGroupState.value;
      const pieces = await this.graph.graphServer.getLeaves(
        focusSegment,
        segmentsState.timestamp.value ?? 0,
        this.graph.branchId.value,
      );
      if (this.splitModeGeneration !== generation) return;
      for (const piece of pieces) {
        segmentsState.segmentEquivalences.link(focusSegment, piece);
      }
      segmentsState.segmentEquivalences.changed.dispatch();
    } catch (e) {
      console.warn("[calcada] failed to fetch pieces for split mode:", e);
    }
  }

  exitSplitMode() {
    if (!this.splitModeActive) return;
    this.splitModeActive = false;
    ++this.splitModeGeneration;
  }

  /**
   * After split, re-link equivalences directly from the components the
   * backend returned. The backend already knows which piece moved to
   * which new root — sending the mapping in the split response lets us
   * rebuild equivalences without round-tripping through /leaves (which
   * the ClickHouse materialised view backing it lags behind on writes)
   * or re-fetching chunks (which silently re-applies the stale LUT for
   * chunks the chunk manager still has cached).
   */
  notifyGraphEdited(oldRoots: Uint64Set, newRoots: Uint64Set) {
    this.state.replaceSegments(oldRoots, newRoots);
  }

  updateAfterSplit(
    oldRoot: bigint,
    newRoots: bigint[],
    components: bigint[][],
  ) {
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    // Drop the old root entirely — its equivalence class no longer
    // represents anything, and leaving it in visibleSegments would let a
    // stray click on a stale chunk re-select the merged blob via cached
    // mesh data.
    segmentsState.visibleSegments.delete(oldRoot);
    segmentsState.selectedSegments.delete(oldRoot);
    for (let i = 0; i < newRoots.length; ++i) {
      segmentsState.visibleSegments.add(newRoots[i]);
      segmentsState.selectedSegments.add(newRoots[i]);
    }
    // One delta: re-point each component's pieces onto its new root and retire
    // the old root. Patches the equivalences table in place instead of forcing
    // a full ~1s rebuild (the old deleteSet + per-piece link path did).
    const groups = newRoots.map((root, i) => ({
      root,
      pieces: components[i] ?? [],
    }));
    segmentsState.segmentEquivalences.applyEquivalenceDelta(groups, [oldRoot]);
    // Deliberately NOT calling refreshChunkSources: it would clear the
    // equivalences we just set, and the chunk re-fetch would race the
    // ClickHouse materialised view that backs the LUT — when the MV
    // hasn't propagated the new piece→root mapping yet, the refreshed
    // chunks restore the OLD mapping and the new roots stop rendering
    // until the user manually reloads. The pieces themselves haven't
    // moved in storage, so the cached chunk pixel data is still valid;
    // the in-memory equivalences here are what drive the shader.
  }

  // Undo stack of recent operations (calcada-only). Ctrl+Z pops the newest and
  // reverts it via the backend. Records general-split applies, merges, and
  // multicuts — each of those pushes its operation_id here.
  private undoStack: { operationId: number; branchId: number }[] = [];

  private static readonly MAX_UNDO_ENTRIES = 50;

  pushUndo(operationId: number, branchId: number) {
    if (operationId > 0) {
      this.undoStack.push({ operationId, branchId });
      if (this.undoStack.length > GraphConnection.MAX_UNDO_ENTRIES) {
        this.undoStack.shift();
      }
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Revert the last edit. Returns whether anything actually reverted, so a
   * caller keeping its own bookkeeping does not have to guess: an empty stack
   * and a failed revert both leave the graph untouched.
   */
  async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      StatusMessage.showTemporaryMessage("Nothing to undo", 2500);
      return false;
    }
    let restoredRoots: bigint[];
    let supersededRoots: bigint[];
    try {
      const result = await this.graph.graphServer.revertOperation(
        entry.operationId,
        entry.branchId,
      );
      restoredRoots = result.restoredRoots;
      supersededRoots = result.supersededRoots;
    } catch (e) {
      // Re-push so the user can retry (e.g. "undo later edits first").
      this.undoStack.push(entry);
      StatusMessage.showTemporaryMessage(
        `Undo failed: ${e instanceof Error ? e.message : String(e)}`,
        8000,
      );
      return false;
    }
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    // Drop the roots this undo retired (the reverted op's outputs), else their
    // stale meshes keep rendering over the restored segment.
    for (const root of supersededRoots) {
      if (root === 0n) continue;
      segmentsState.selectedSegments.delete(root);
      segmentsState.visibleSegments.delete(root);
    }
    for (const root of restoredRoots) {
      if (root === 0n) continue;
      segmentsState.selectedSegments.add(root);
      segmentsState.visibleSegments.add(root);
    }
    const restored = restoredRoots.filter((r) => r !== 0n);
    // Restored roots keep the same id as before the edit, so force their cached
    // 3D meshes to re-download (their leaves reverted to the original pieces).
    this.meshAddNewSegments(restored);
    this.meshRefreshSegments(restored);
    this.refreshChunkSources();
    StatusMessage.showTemporaryMessage(
      `Undo applied — restored ${restoredRoots.length} root(s)`,
      5000,
    );
    return true;
  }

  setDebugPieces(
    rootId: bigint | undefined,
    colors: Map<bigint, bigint> | undefined,
  ) {
    this.debugPiecesRoot = rootId;
    this.debugPiecesColors = colors;
    this.debugTabHidden.value = colors === undefined;
    if (colors === undefined) {
      const meshSource = this.getMeshSource();
      if (
        meshSource instanceof MeshSource &&
        meshSource.hiddenFragmentSegments.size !== 0
      ) {
        meshSource.hiddenFragmentSegments.clear();
        this.redrawRenderLayers();
      }
    }
    this.debugPiecesChanged.dispatch();
  }

  pieceMeshHidden(piece: bigint): boolean {
    const meshSource = this.getMeshSource();
    return (
      meshSource instanceof MeshSource &&
      meshSource.hiddenFragmentSegments.has(piece)
    );
  }

  // Toggles one piece's mesh in the debug piece view. MeshLayer skips hidden
  // fragments only while per-fragment colouring is active, so normal rendering
  // is unaffected.
  togglePieceMesh(piece: bigint) {
    const meshSource = this.getMeshSource();
    if (!(meshSource instanceof MeshSource)) return;
    if (meshSource.hiddenFragmentSegments.has(piece)) {
      meshSource.hiddenFragmentSegments.delete(piece);
    } else {
      meshSource.hiddenFragmentSegments.add(piece);
    }
    this.redrawRenderLayers();
    this.debugPiecesChanged.dispatch();
  }

  redrawRenderLayers() {
    for (const renderLayer of this.layer.renderLayers) {
      renderLayer.redrawNeeded.dispatch();
    }
  }

  meshAddNewSegments(segments: bigint[]) {
    const meshSource = this.getMeshSource();
    if (!meshSource) return;
    // Defer the mesh fetch until the 2D equivalences update has painted. The
    // mesh pipeline (fetch/decode/GPU upload of a large neuron) hogs the main
    // thread and the worker-snapshot ack path, delaying the 2D recolour by
    // 1-2s after an edit. requestIdleCallback fires once the main thread goes
    // idle — i.e. after the 2D paint — with a timeout so the mesh always loads.
    const fetchMeshes = () => {
      // Deferred: the source may have been disposed (layer removed / chunk
      // sources refreshed) between scheduling and firing, so re-check.
      const { rpc, rpcId } = meshSource;
      if (!rpc || rpcId === undefined) return;
      for (const segment of segments) {
        rpc.invoke(CALCADA_MESH_NEW_SEGMENT_RPC_ID, {
          rpcId,
          segment,
        });
      }
    };
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      idle(fetchMeshes, { timeout: 500 });
    } else {
      setTimeout(fetchMeshes, 100);
    }
  }

  meshPrefetchSegments(segments: bigint[]) {
    const meshSource = this.getMeshSource();
    if (!meshSource) return;
    const prefetch = () => {
      const { rpc, rpcId } = meshSource;
      if (!rpc || rpcId === undefined) return;
      for (const segment of segments) {
        rpc.invoke(CALCADA_MESH_PREFETCH_SEGMENT_RPC_ID, { rpcId, segment });
      }
    };
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      idle(prefetch, { timeout: 500 });
    } else {
      setTimeout(prefetch, 100);
    }
  }

  // Force a re-download of roots whose id did not change but whose leaves did
  // (keep-whole piece split / its undo). meshAddNewSegments only re-fetches
  // manifests the mesh layer requests fresh, so a still-cached root would keep
  // showing its pre-split 3D mesh; this requeues the cached manifest chunk.
  meshRefreshSegments(segments: bigint[]) {
    const meshSource = this.getMeshSource();
    if (!meshSource) return;
    const refresh = () => {
      const { rpc, rpcId } = meshSource;
      if (!rpc || rpcId === undefined) return;
      for (const segment of segments) {
        rpc.invoke(CALCADA_MESH_REFRESH_SEGMENT_RPC_ID, { rpcId, segment });
      }
    };
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      idle(refresh, { timeout: 500 });
    } else {
      setTimeout(refresh, 100);
    }
  }

  setDebugEdges(edgeLines: Line[], siblingLines: Line[]) {
    this.clearDebugEdges();
    for (const line of edgeLines)
      this.debugEdgeAnnotationState.source.add(line);
    for (const line of siblingLines)
      this.debugSiblingAnnotationState.source.add(line);
  }

  clearDebugEdges() {
    (this.debugEdgeAnnotationState.source as AnnotationSource).clear();
    (this.debugSiblingAnnotationState.source as AnnotationSource).clear();
  }

  async submitMulticut(annotationToNanometers: Float64Array): Promise<boolean> {
    const {
      state: { multicutState },
    } = this;
    const { sinks, sources } = multicutState;
    if (sinks.size === 0 || sources.size === 0) {
      StatusMessage.showTemporaryMessage(
        "Must select both red and blue groups to perform a multi-cut.",
        7000,
      );
      return false;
    } else {
      const {
        roots: splitRoots,
        components,
        operationId,
      } = await this.graph.graphServer.splitSegments(
        [...sinks].map((x) => selectionInNanometers(x, annotationToNanometers)),
        [...sources].map((x) =>
          selectionInNanometers(x, annotationToNanometers),
        ),
        this.graph.branchId.value,
      );
      if (splitRoots.length === 0) {
        StatusMessage.showTemporaryMessage(`No split found.`, 3000);
        return false;
      } else {
        const focusSegment = multicutState.focusSegment.value!;
        multicutState.reset(); // need to clear the focus segment before deleting the multicut segment
        const { segmentsState } = this;
        segmentsState.selectedSegments.delete(focusSegment);
        for (const segment of [...sinks, ...sources]) {
          segmentsState.selectedSegments.delete(segment.rootId);
        }
        this.meshAddNewSegments(splitRoots);
        segmentsState.selectedSegments.add(splitRoots);
        segmentsState.visibleSegments.add(splitRoots);
        const oldValues = new Uint64Set();
        oldValues.add(focusSegment);
        const newValues = new Uint64Set();
        newValues.add(splitRoots);
        this.notifyGraphEdited(oldValues, newValues);
        this.updateAfterSplit(focusSegment, splitRoots, components);
        this.pushUndo(operationId, this.graph.branchId.value);
        return true;
      }
    }
  }

  deleteMergeSubmission = (submission: MergeSubmission) => {
    const { mergeAnnotationState } = this;
    submission.locked = false;
    mergeAnnotationState.source.delete(
      mergeAnnotationState.source.getReference(submission.id),
    );
  };

  /**
   * Merge two selections outside the merge-line UI, for Zetta Trace.
   *
   * Delegates to submitMerge so the display bookkeeping it does — equivalence
   * replacement, mesh registration for the new root, retries — happens here too
   * rather than being reimplemented.
   */
  mergeSelections = async (
    sink: SegmentSelection,
    source: SegmentSelection,
  ): Promise<bigint> => {
    return this.submitMerge({
      id: `zetta-trace-${sink.segmentId}-${source.segmentId}`,
      locked: false,
      sink,
      source,
    });
  };

  private submitMerge = async (
    submission: MergeSubmission,
    attempts = 1,
  ): Promise<bigint> => {
    this.graph;
    const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
    const annotationToNanometers =
      loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
        (x) => x / 1e-9,
      );
    submission.error = undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        // Capture old root IDs BEFORE merge (replaceSegments modifies them)
        const oldRootA = submission.sink.rootId;
        const oldRootB = submission.source!.rootId;

        const {
          root: newRoot,
          pieces: mergedPieces,
          operationId,
        } = await this.graph.graphServer.mergeSegments(
          selectionInNanometers(submission.sink, annotationToNanometers),
          selectionInNanometers(submission.source!, annotationToNanometers),
          this.graph.branchId.value,
        );
        const oldValues = new Uint64Set();
        oldValues.add(oldRootA);
        oldValues.add(oldRootB);
        const newValues = new Uint64Set();
        newValues.add(newRoot);
        this.notifyGraphEdited(oldValues, newValues);

        const segmentsState =
          this.layer.displayState.segmentationGroupState.value;
        segmentsState.visibleSegments.add(newRoot);
        segmentsState.selectedSegments.add(newRoot);
        // Register the new root with the mesh source so its mesh fragments
        // are fetched — without this the post-merge 3D view rendered only
        // the slice of pieces that happened to load via residual chunks
        // and the full merged volume only appeared after a manual reload.
        this.meshAddNewSegments([newRoot]);
        this.pushUndo(operationId, this.graph.branchId.value);
        // Populate equivalences directly from the merge response's `pieces`
        // field — server returns the union of pieces from both pre-merge
        // roots, so we avoid the post-edit /leaves round-trip that goes
        // through the lagging pieces_latest_by_root MV. Mirror
        // updateAfterSplit: deliberately NO refreshChunkSources here — it
        // clears the equivalences we just set and the chunk re-fetch races
        // the same MV, intermittently leaving one of the merged segments
        // unhighlighted in 2D until the MV catches up. The chunk pixel data
        // is unchanged by a merge; these in-memory links are all the shader
        // needs.
        if (mergedPieces.length > 0) {
          // One delta: re-point the merged pieces onto newRoot and retire the
          // old roots. Patches the equivalences table in place rather than
          // forcing a full ~1s rebuild (the old deleteSet + per-piece link each
          // bumped the generation into a full rebuild).
          segmentsState.segmentEquivalences.applyEquivalenceDelta(
            [{ root: newRoot, pieces: mergedPieces }],
            [oldRootA, oldRootB],
          );
        } else {
          // Legacy-server fallback (no `pieces` in the merge response): keep
          // the old roots visible while the async /leaves resolves, and
          // refresh chunks so their LUT trailers rebuild the mapping.
          segmentsState.segmentEquivalences.deleteSet(oldRootA);
          segmentsState.segmentEquivalences.deleteSet(oldRootB);
          segmentsState.visibleSegments.add(oldRootA);
          segmentsState.visibleSegments.add(oldRootB);
          this.graph.graphServer
            .getLeaves(
              newRoot,
              segmentsState.timestamp.value ?? 0,
              this.graph.branchId.value,
            )
            .then((pieces) => {
              for (const piece of pieces) {
                segmentsState.segmentEquivalences.link(newRoot, piece);
              }
            })
            .catch((e: unknown) => {
              StatusMessage.showTemporaryMessage(
                `Failed to load pieces for ${newRoot}: ${e instanceof Error ? e.message : String(e)}`,
                6000,
              );
            });
          this.refreshChunkSources();
        }
        return newRoot;
      } catch (err) {
        if (i === attempts) {
          submission.error = err.message || "unknown";
          throw err;
        }
      }
    }

    return 0n; // appease typescript
  };

  async bulkMerge(submissions: MergeSubmission[]) {
    const { merges } = this.state.mergeState;
    const bulkMergeHelper = (
      submissions: MergeSubmission[],
    ): Promise<bigint[]> => {
      return new Promise((f) => {
        if (submissions.length === 0) {
          f([]);
          return;
        }
        const segmentsToRemove: bigint[] = [];
        let completed = 0;
        let activeLoops = 0;
        const loop = (completedAt: number, pending: MergeSubmission[]) => {
          if (completed === submissions.length || pending.length === 0) return;
          activeLoops++;
          let failed: MergeSubmission[] = [];
          const checkDone = () => {
            loopDone++;
            if (loopDone === pending.length) {
              activeLoops -= 1;
            }
            if (activeLoops === 0) {
              f(segmentsToRemove);
            }
          };
          let loopDone = 0;
          for (const submission of pending) {
            submission.locked = true;
            submission.status = "trying...";
            merges.changed.dispatch();
            const segments = [
              submission.source!.rootId,
              submission.sink.rootId,
            ];
            this.submitMerge(submission, 3)
              .then((mergedRoot) => {
                segmentsToRemove.push(...segments);
                submission.status = "done";
                submission.mergedRoot = mergedRoot;
                merges.changed.dispatch();
                completed += 1;
                loop(completed, failed);
                failed = [];
                checkDone();
                this.deleteMergeSubmission(submission);
              })
              .catch(() => {
                merges.changed.dispatch();
                failed.push(submission);
                if (completed > completedAt) {
                  loop(completed, failed);
                  failed = [];
                }
                checkDone();
              });
          }
        };
        loop(completed, submissions);
      });
    };

    submissions = submissions.filter((x) => !x.locked && x.source);
    const segmentsToRemove = await bulkMergeHelper(submissions);
    const segmentsToAdd: bigint[] = [];
    for (const submission of submissions) {
      if (submission.error) {
        submission.locked = false;
        submission.status = submission.error;
      } else if (submission.mergedRoot) {
        segmentsToAdd.push(submission.mergedRoot);
      }
    }
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    // submitMerge already applied every merged root to the display: mesh,
    // visible+selected, and equivalences (linked from the merge response's
    // pieces). All that remains for a single merge is dropping the retired
    // roots from the selection.
    segmentsState.selectedSegments.delete(segmentsToRemove);
    // The re-resolve + getLeaves below only matter for chained BATCH merges,
    // where a root submitMerge just showed may have been merged again earlier in
    // the same batch. For a single interactive merge it only re-does submitMerge's
    // work and, worse, mutates segmentEquivalences twice more (deleteSet + async
    // link) — each forcing another full GPU equivalences-table rebuild (~1s at
    // FAFB scale) on top of the one submitMerge already triggered.
    if (submissions.length > 1) {
      const latestRoots = await this.graph.graphServer.filterLatestRoots(
        segmentsToAdd,
        segmentsState.timestamp.value ?? 0,
        false,
        this.graph.branchId.value,
      );
      const { visibleSegments, selectedSegments } = segmentsState;
      this.meshAddNewSegments(latestRoots);
      selectedSegments.add(latestRoots);
      visibleSegments.add(latestRoots);
      for (const oldRoot of segmentsToRemove) {
        segmentsState.segmentEquivalences.deleteSet(oldRoot);
      }
      for (const newRoot of latestRoots) {
        this.graph.graphServer
          .getLeaves(
            newRoot,
            segmentsState.timestamp.value ?? 0,
            this.graph.branchId.value,
          )
          .then((pieces) => {
            for (const piece of pieces) {
              segmentsState.segmentEquivalences.link(newRoot, piece);
            }
          })
          .catch((e: unknown) => {
            StatusMessage.showTemporaryMessage(
              `Failed to load pieces for ${newRoot}: ${e instanceof Error ? e.message : String(e)}`,
              6000,
            );
          });
      }
    }
    merges.changed.dispatch();
  }

  async submitFindPath(
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
  ): Promise<boolean> {
    const {
      state: { findPathState },
    } = this;
    const { source, target } = findPathState;
    if (!source.value || !target.value) return false;
    const centroids = await this.graph.findPath(
      source.value,
      target.value,
      precisionMode,
      annotationToNanometers,
    );
    StatusMessage.showTemporaryMessage("Path found!", 5000);
    findPathState.centroids.value = centroids;
    return true;
  }
}

async function withErrorMessageHTTP<T>(
  promise: Promise<T>,
  options: {
    initialMessage?: string;
    errorPrefix: string;
  },
): Promise<T> {
  let status: StatusMessage | undefined = undefined;
  let dispose = () => {};
  if (options.initialMessage) {
    status = new StatusMessage(true);
    status.setText(options.initialMessage);
    dispose = status.dispose.bind(status);
  }
  try {
    const response = await promise;
    dispose();
    return response;
  } catch (e) {
    if (e instanceof HttpError && e.response) {
      const { errorPrefix = "" } = options;
      const msg = (await parseCalcadaError(e)) || "unknown error";
      if (!status) {
        status = new StatusMessage(true);
      }
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
      throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
    }
    throw e;
  }
}

const selectionInNanometers = (
  selection: SegmentSelection,
  annotationToNanometers: Float64Array,
): SegmentSelection => {
  const { rootId, segmentId, position } = selection;
  return {
    rootId,
    segmentId,
    position: position.map((val, i) => val * annotationToNanometers[i]),
  };
};

function defaultParentForNewBranch(graph: CalcadaGraphSource): number {
  return graph.branchId.value;
}

const BRANCH_CREATING_POLL_MS = 2000;
const BRANCH_CREATING_POLL_LIMIT = 300;

function watchBranchUntilActive(
  graph: CalcadaGraphSource,
  id: number,
  originBranchId: number,
  isCancelled: () => boolean,
  attempt = 0,
): void {
  if (isCancelled() || attempt >= BRANCH_CREATING_POLL_LIMIT) return;
  const entry = graph.branches.value.find((branch) => branch.id === id);
  if (entry !== undefined && entry.status === "active") {
    // Only follow the user onto the new branch if they're still where they
    // were when the fork was requested — a slow copy can take minutes, and
    // switching branchId out from under someone who navigated elsewhere
    // would wipe their selected segments and undo stack.
    if (graph.branchId.value === originBranchId) {
      graph.branchId.value = id;
    }
    return;
  }
  if (entry !== undefined && entry.status === "abandoned") return;
  graph.triggerBranchRefresh();
  setTimeout(
    () =>
      watchBranchUntilActive(
        graph,
        id,
        originBranchId,
        isCancelled,
        attempt + 1,
      ),
    BRANCH_CREATING_POLL_MS,
  );
}

function appendCoordParams(
  url: string,
  coord: { timestamp?: number; branchId?: number },
): string {
  const parts: string[] = [];
  if (coord.timestamp !== undefined && coord.timestamp > 0) {
    parts.push(`timestamp=${coord.timestamp / 1000}`);
  }
  if (coord.branchId !== undefined && coord.branchId !== 0) {
    parts.push(`branch_id=${coord.branchId}`);
  }
  if (parts.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${parts.join("&")}`;
}

class CalcadaGraphServerInterface {
  constructor(private httpSource: HttpSource) {}

  async getTimestampLimit() {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const response = await fetchOkImpl(`${baseUrl}/oldest_timestamp`).then(
      (response) => response.json(),
    );
    const isoString = verifyObjectProperty(response, "iso", verifyString);
    return new Date(isoString).valueOf();
  }

  async getRoot(segment: bigint, timestamp = 0, branchId = 0) {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/root?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving root for segment ${segment}`,
        errorPrefix: "Could not fetch root: ",
      },
    );
    return parseUint64(jsonResp.root_id);
  }

  async getLeaves(
    segment: bigint,
    timestamp = 0,
    branchId = 0,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/leaves?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving leaves for segment ${segment}`,
        errorPrefix: "Could not fetch leaves: ",
      },
    );
    const leafIds: string[] = jsonResp.leaf_ids || [];
    return leafIds.map(parseUint64);
  }

  async getEdgeComponents(
    segment: bigint,
    timestamp = 0,
    branchId = 0,
  ): Promise<bigint[][]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/components?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving components for segment ${segment}`,
        errorPrefix: "Could not fetch components: ",
      },
    );
    const components: string[][] = jsonResp.components || [];
    return components.map((c) => c.map(parseUint64));
  }

  // debugGraph fetches a root's pieces (with bbox centres) and edges (with
  // status), for the piece-split tool's debug overlay: colour each piece
  // distinctly and draw a line per edge. Reveals a kept-whole segment's internal
  // structure once a piece split has left it a single colour.
  async debugGraph(
    segment: bigint,
    timestamp = 0,
    branchId = 0,
  ): Promise<{
    pieces: {
      id: bigint;
      center: [number, number, number];
      external: boolean;
    }[];
    edges: {
      a: bigint;
      b: bigint;
      affinity: number;
      area: number;
      status: string;
      pos: [number, number, number];
    }[];
  }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/debug_graph?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving debug graph for segment ${segment}`,
        errorPrefix: "Could not fetch debug graph: ",
      },
    );
    const pieces = (jsonResp.pieces || []).map(
      (p: {
        id: string;
        center: [number, number, number];
        external?: boolean;
      }) => ({
        id: parseUint64(p.id),
        center: p.center,
        external: p.external === true,
      }),
    );
    const edges = (jsonResp.edges || []).map(
      (e: {
        a: string;
        b: string;
        affinity: number;
        area: number;
        status: string;
        pos?: [number, number, number];
      }) => ({
        a: parseUint64(e.a),
        b: parseUint64(e.b),
        affinity: e.affinity,
        area: e.area,
        status: e.status,
        pos: e.pos ?? ([0, 0, 0] as [number, number, number]),
      }),
    );
    return { pieces, edges };
  }

  async mergeSegments(
    first: SegmentSelection,
    second: SegmentSelection,
    branchId = 0,
  ): Promise<{ root: bigint; pieces: bigint[]; operationId: number }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      appendCoordParams(`${baseUrl}/merge?int64_as_str=1`, { branchId }),
      {
        method: "POST",
        // Edits are user-blocking: hint the browser to send this ahead of the
        // low-priority chunk/mesh downloads that otherwise saturate the
        // connection and stall the request in the queue.
        priority: "high",
        body: JSON.stringify([
          [String(first.segmentId), ...first.position],
          [String(second.segmentId), ...second.position],
        ]),
      },
    );
    try {
      const response = await promise;
      const jsonResp = await response.json();
      const root = parseUint64(jsonResp.new_root_ids[0]);
      // Server returns the union of pieces from the two merged roots so the
      // client can populate equivalences without an extra /leaves round-trip
      // that goes through the lagging pieces_latest_by_root MV.
      const rawPieces: string[] = jsonResp.pieces ?? [];
      const pieces = rawPieces.map(parseUint64);
      const operationId = Number(jsonResp.operation_id ?? 0);
      return { root, pieces, operationId };
    } catch (e) {
      if (e instanceof HttpError) {
        const msg = await parseCalcadaError(e);
        throw new Error(msg);
      }
      throw e;
    }
  }

  async fetchCandidates(
    rootId: bigint,
    opts: {
      batch: string;
      limit?: number;
      minScore?: number;
      minPieceVoxels?: number;
      rejectedBy?: string[];
      branchId?: number;
      // Speculative callers pass "low" so they cannot preempt the fetch the
      // proofreader is actually waiting on.
      priority?: "high" | "low";
    },
  ): Promise<EdgeCandidate[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    // batch is required by the server: with several contact waves in the same
    // tables, silently serving the wrong one is worse than failing.
    const params = new URLSearchParams({
      int64_as_str: "1",
      batch: opts.batch,
    });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.minScore !== undefined) {
      params.set("min_score", String(opts.minScore));
    }
    if (opts.minPieceVoxels) {
      params.set("min_piece_voxels", String(opts.minPieceVoxels));
    }
    // Omitted entirely when empty, which the server reads as "anyone's
    // rejection counts" — an empty parameter would mean the same thing but
    // relies on the server trimming blanks.
    if (opts.rejectedBy?.length) {
      params.set("rejected_by", opts.rejectedBy.join(","));
    }
    if (opts.branchId) params.set("branch_id", String(opts.branchId));
    const response = await fetchOkImpl(
      `${baseUrl}/segment/${rootId}/candidates?${params.toString()}`,
      { priority: opts.priority ?? "high" },
    );
    const jsonResp = await response.json();
    return (jsonResp.candidates ?? []).map(
      (c: any): EdgeCandidate => ({
        lineId: parseUint64(c.line_id),
        score: Number(c.score),
        selfPieceId: parseUint64(c.self_piece_id),
        partnerPieceId: parseUint64(c.partner_piece_id),
        partnerRootId: parseUint64(c.partner_root_id),
        pointA: Float32Array.from(c.point_a),
        pointB: Float32Array.from(c.point_b),
        nInterfaces: Number(c.n_interfaces),
        modelDecision: String(c.model_decision),
      }),
    );
  }

  async postCandidateDecision(
    lineId: bigint,
    decision: "accept" | "reject" | "defer",
    operationId?: number,
    branchId = 0,
  ): Promise<void> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const params = new URLSearchParams();
    if (branchId) params.set("branch_id", String(branchId));
    const query = params.toString();
    await fetchOkImpl(
      `${baseUrl}/candidates/decision${query ? `?${query}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({
          line_id: String(lineId),
          decision,
          ...(operationId === undefined ? {} : { operation_id: operationId }),
        }),
      },
    );
  }

  async splitSegments(
    first: SegmentSelection[],
    second: SegmentSelection[],
    branchId = 0,
  ): Promise<{ roots: bigint[]; components: bigint[][]; operationId: number }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      appendCoordParams(`${baseUrl}/split?int64_as_str=1`, { branchId }),
      {
        method: "POST",
        // See mergeSegments: edits jump the chunk/mesh download queue.
        priority: "high",
        body: JSON.stringify({
          sources: first.map((x) => [String(x.segmentId), ...x.position]),
          sinks: second.map((x) => [String(x.segmentId), ...x.position]),
        }),
      },
    );
    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: "Split failed: ",
    });
    const jsonResp = await response.json();
    const roots: bigint[] = new Array(jsonResp.new_root_ids.length);
    for (let i = 0; i < roots.length; ++i) {
      roots[i] = parseUint64(jsonResp.new_root_ids[i]);
    }
    const rawComponents: string[][] = jsonResp.components || [];
    const components = rawComponents.map((c) => c.map(parseUint64));
    const operationId = Number(jsonResp.operation_id ?? 0);
    return { roots, components, operationId };
  }

  // splitByPieces is the second half of a stepped split: the regular multicut,
  // told which pieces are the blue side and which the red rather than deriving
  // them from coordinates. After generalSplit(piecesOnly) the parent piece no
  // longer exists, so its sub-pieces have to be named directly.
  async splitByPieces(
    sourcePieces: bigint[],
    sinkPieces: bigint[],
    branchId = 0,
  ): Promise<{ roots: bigint[]; components: bigint[][]; operationId: number }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      appendCoordParams(`${baseUrl}/split?int64_as_str=1`, { branchId }),
      {
        method: "POST",
        priority: "high",
        body: JSON.stringify({
          source_pieces: sourcePieces.map((x) => x.toString()),
          sink_pieces: sinkPieces.map((x) => x.toString()),
        }),
      },
    );
    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Cutting ${sourcePieces.length} source piece(s) from ${sinkPieces.length}`,
      errorPrefix: "Split failed: ",
    });
    const jsonResp = await response.json();
    const rootIds: string[] = jsonResp.new_root_ids ?? [];
    const rawComponents: string[][] = jsonResp.components || [];
    return {
      roots: rootIds.map((x) => parseUint64(x)),
      components: rawComponents.map((c) => c.map(parseUint64)),
      operationId: Number(jsonResp.operation_id ?? 0),
    };
  }

  // generalSplit runs the whole split in one atomic backend operation: it cuts
  // every piece holding BOTH colours in two, then multicuts the segment into two
  // roots — returned as roots + components (Components[i] belongs to roots[i]).
  // One op, so a single Ctrl+Z reverts it. origin records 2D (exact voxel) vs 3D
  // (mesh pick; the backend snaps to the nearest in-piece voxel).
  async generalSplit(
    points: {
      color: "blue" | "red";
      pieceId: bigint;
      x: number;
      y: number;
      z: number;
      origin: "2d" | "3d";
    }[],
    branchId = 0,
    // piecesOnly stops after the piece split: the sub-pieces and the edges
    // derived for them are written, the segment stays whole, and the multicut is
    // left to a separate call. It exists to make that intermediate graph
    // inspectable, which is otherwise invisible.
    piecesOnly = false,
    // useImage prices the voxel min-cut from the EM image. Off by default: the
    // backend then skips the image read entirely and cuts on geometry alone.
    useImage = false,
  ): Promise<{
    operationId: number;
    roots: bigint[];
    components: bigint[][];
    splitPieces: { old: bigint; blue: bigint; red: bigint }[];
  }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    let response: Response;
    try {
      response = await fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/split/general?int64_as_str=1${piecesOnly ? "&pieces_only=true" : ""}`,
          { branchId },
        ),
        {
          method: "POST",
          body: JSON.stringify({
            points: points.map((p) => ({
              color: p.color,
              // piece_id is a tagged uint64 > 2^53; send as a string.
              piece_id: p.pieceId.toString(),
              x: p.x,
              y: p.y,
              z: p.z,
              origin: p.origin,
            })),
            use_image: useImage,
          }),
        },
      );
    } catch (e) {
      throw await wrapCalcadaError(e);
    }
    const jsonResp = await response.json();
    const rootIds: string[] = jsonResp.new_root_ids ?? [];
    const comps: string[][] = jsonResp.components ?? [];
    const subs: { old: string; blue: string; red: string }[] =
      jsonResp.split_pieces ?? [];
    return {
      operationId: Number(jsonResp.operation_id ?? 0),
      roots: rootIds.map((x) => parseUint64(x)),
      components: comps.map((c) => c.map((x) => parseUint64(x))),
      splitPieces: subs.map((sp) => ({
        old: parseUint64(sp.old),
        blue: parseUint64(sp.blue),
        red: parseUint64(sp.red),
      })),
    };
  }

  // revertOperation asks the backend to undo a prior edit (calcada-only). It
  // re-asserts the operation's pre-edit graph state and, for voxel-changing
  // splits, restores the branch-overlay voxels. Returns the restored roots so
  // the caller can refresh selection/mesh.
  async revertOperation(
    operationId: number,
    branchId = 0,
  ): Promise<{
    operationId: number;
    restoredRoots: bigint[];
    supersededRoots: bigint[];
  }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    let response: Response;
    try {
      response = await fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/operation/${operationId}/revert?int64_as_str=1`,
          { branchId },
        ),
        { method: "POST" },
      );
    } catch (e) {
      throw await wrapCalcadaError(e);
    }
    const jsonResp = await response.json();
    const rootIds: string[] = jsonResp.restored_root_ids ?? [];
    const superseded: string[] = jsonResp.superseded_root_ids ?? [];
    return {
      operationId: Number(jsonResp.operation_id ?? 0),
      restoredRoots: rootIds.map((x) => parseUint64(x)),
      supersededRoots: superseded.map((x) => parseUint64(x)),
    };
  }

  async filterLatestRoots(
    segments: bigint[],
    timestamp = 0,
    flipResult = false,
    branchId = 0,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const url = appendCoordParams(`${baseUrl}/is_latest_roots`, {
      timestamp,
      branchId,
    });
    const promise = fetchOkImpl(url, {
      method: "POST",
      body: JSON.stringify({ node_ids: segments.map((x) => x.toString()) }),
    });
    const jsonResp = await withErrorMessageHTTP(
      promise.then((response) => response.json()),
      {
        errorPrefix: "Could not check latest: ",
      },
    );
    const res: bigint[] = [];
    for (const [i, isLatest] of jsonResp.is_latest.entries()) {
      if (isLatest !== flipResult) {
        res.push(segments[i]);
      }
    }
    return res;
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
  ) {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      `${baseUrl}/graph/find_path?int64_as_str=1&precision_mode=${Number(
        precisionMode,
      )}`,
      {
        method: "POST",
        body: JSON.stringify([
          [String(first.rootId), ...first.position],
          [String(second.rootId), ...second.position],
        ]),
      },
    );
    const jsonResp = await withErrorMessageHTTP(
      promise.then((response) => response.json()),
      {
        initialMessage: `Finding path between ${first.segmentId} and ${second.segmentId}`,
        errorPrefix: "Path finding failed: ",
      },
    );
    const pieceCentroidsKey = "centroids_list";
    const centroids = verifyObjectProperty(jsonResp, pieceCentroidsKey, (x) =>
      parseArray(x, verifyFloatArray),
    );
    const missingL2IdsKey = "failed_l2_ids";
    const missingL2Ids = jsonResp[missingL2IdsKey];
    if (missingL2Ids && missingL2Ids.length > 0) {
      StatusMessage.showTemporaryMessage(
        "Some level 2 meshes are missing, so the path shown may have a poor level of detail.",
      );
    }
    const l2_path = verifyOptionalObjectProperty(
      jsonResp,
      "l2_path",
      verifyStringArray,
    );
    return {
      centroids,
      l2_path,
    };
  }
}

export interface CalcadaLabeledTimestamp {
  id: string;
  label: string;
  timestampMs: number;
  visibility: string;
}

class CalcadaGraphSource extends SegmentationGraphSource {
  public graphServer: CalcadaGraphServerInterface;
  private l2CacheAvailable: boolean | undefined = undefined;
  private httpSource: HttpSource;
  public timestampLimit = new TrackableValue<number>(0, (x) => x);
  public branches = new WatchableValue<
    { id: number; name: string; status: string; parentId: number }[]
  >([]);
  public labeledTimestamps = new WatchableValue<CalcadaLabeledTimestamp[]>([]);
  private branchesFetched = false;

  public get branchId(): TrackableValue<number> {
    return this.state.branchId;
  }

  constructor(
    public info: CalcadaMultiscaleVolumeInfo,
    private chunkSource: CalcadaMultiscaleVolumeChunkSource,
    public state: CalcadaState,
  ) {
    super();
    const url = info.app!.segmentationUrl;
    this.httpSource = getHttpSource(
      chunkSource.sharedKvStoreContext.kvStoreContext,
      url,
    );
    this.graphServer = new CalcadaGraphServerInterface(this.httpSource);
    this.graphServer.getTimestampLimit().then((limit) => {
      this.timestampLimit.value = limit;
    });
    this.startBranchRefreshWithRetry();
    this.startLabeledTimestampRefreshWithRetry();
    this.branchId.changed.add(() => this.triggerLabeledTimestampRefresh());
  }

  // startBranchRefreshWithRetry kicks off /branches and retries on failure —
  // the first call commonly races with the middleauth token handshake and
  // 401s. Without retry the dropdown stays stuck on "main" even after the
  // user is authenticated. Retries back off and stop after a few attempts so
  // a truly broken endpoint doesn't loop forever.
  private startBranchRefreshWithRetry(): void {
    const maxAttempts = 5;
    const baseDelayMs = 1500;
    let attempt = 0;
    const tick = () => {
      this.refreshBranches().catch((e) => {
        attempt++;
        if (attempt >= maxAttempts) {
          console.warn("Failed to fetch calcada branches:", e);
          return;
        }
        setTimeout(tick, baseDelayMs * attempt);
      });
    };
    tick();
  }

  private async refreshBranches(): Promise<void> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    // include_abandoned=true so the dropdown shows merged/abandoned branches
    // too — restoring state with branchId pointing at an abandoned branch
    // (e.g. an old diff link) needs that option to exist or the select falls
    // back to "main" and looks like the state didn't load. baseUrl is the
    // kvStore-resolved URL (no "middleauth+" prefix); fetchOkImpl on the raw
    // info.app.segmentationUrl fails because browser fetch() rejects the
    // middleauth+ scheme — the bug that left this dropdown empty all along.
    const url = `${baseUrl}/branches?include_abandoned=true`;
    const response = await fetchOkImpl(url);
    const data = await response.json();
    if (!Array.isArray(data)) {
      this.branches.value = [];
      return;
    }
    const parsed: {
      id: number;
      name: string;
      status: string;
      parentId: number;
    }[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as any).branch_id;
      const name = (entry as any).branch_name;
      const status = (entry as any).status;
      const parentId = (entry as any).parent_branch_id;
      if (typeof id !== "number" || id === 0) continue;
      if (typeof name !== "string") continue;
      parsed.push({
        id,
        name,
        status: typeof status === "string" ? status : "active",
        parentId: typeof parentId === "number" ? parentId : 0,
      });
    }
    this.branches.value = parsed;
    this.branchesFetched = true;
  }

  public get hasFetchedBranches(): boolean {
    return this.branchesFetched;
  }

  public triggerBranchRefresh(): void {
    this.refreshBranches().catch((e) => {
      console.warn("Failed to refresh calcada branches:", e);
    });
  }

  // Same middleauth-handshake race as startBranchRefreshWithRetry: the first
  // fetch commonly 401s before the token is ready, so back off and retry.
  private startLabeledTimestampRefreshWithRetry(): void {
    const maxAttempts = 5;
    const baseDelayMs = 1500;
    let attempt = 0;
    const tick = () => {
      this.refreshLabeledTimestamps().catch((e) => {
        attempt++;
        if (attempt >= maxAttempts) {
          console.warn("Failed to fetch calcada labeled timestamps:", e);
          return;
        }
        setTimeout(tick, baseDelayMs * attempt);
      });
    };
    tick();
  }

  private async refreshLabeledTimestamps(): Promise<void> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const url = `${baseUrl}/labeled_timestamps?branch_id=${this.branchId.value}`;
    const response = await fetchOkImpl(url);
    const data = await response.json();
    if (!Array.isArray(data)) {
      this.labeledTimestamps.value = [];
      return;
    }
    const parsed: CalcadaLabeledTimestamp[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as any).id;
      const label = (entry as any).label;
      const timestampSeconds = (entry as any).timestamp;
      const visibility = (entry as any).visibility;
      if (typeof id !== "string" || typeof label !== "string") continue;
      if (typeof timestampSeconds !== "number" || timestampSeconds <= 0) {
        continue;
      }
      parsed.push({
        id,
        label,
        timestampMs: Math.round(timestampSeconds * 1000),
        visibility: typeof visibility === "string" ? visibility : "public",
      });
    }
    this.labeledTimestamps.value = parsed;
  }

  public triggerLabeledTimestampRefresh(): void {
    this.refreshLabeledTimestamps().catch((e) => {
      console.warn("Failed to refresh calcada labeled timestamps:", e);
    });
  }

  public async createBranch(
    branchName: string,
    parentBranchId: number,
  ): Promise<Response> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    return fetchOkImpl(`${baseUrl}/branch/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch_name: branchName,
        parent_branch_id: parentBranchId,
      }),
    });
  }

  connect(
    layer: SegmentationUserLayer,
  ): Owned<SegmentationGraphSourceConnection> {
    return new GraphConnection(this, layer, this.chunkSource, this.state);
  }

  get visibleSegmentEquivalencePolicy() {
    return (
      VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
      VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED
    );
  }

  getRoot(segment: bigint, timestamp?: number) {
    return this.graphServer.getRoot(segment, timestamp, this.branchId.value);
  }

  async isL2CacheUrlAvailable() {
    if (this.l2CacheAvailable !== undefined) {
      return this.l2CacheAvailable;
    }
    try {
      const { l2CacheUrl, table } = this.info.app;
      const tableMapping = await fetchOk(`${l2CacheUrl}/table_mapping`).then(
        (response) => response.json(),
      );
      verifyObject(tableMapping);
      this.l2CacheAvailable = !!(tableMapping && tableMapping[table]);
      return this.l2CacheAvailable;
    } catch (e) {
      console.error("L2 cache check failed:", e);
      return false;
    }
  }

  async getAttributesForL2Ids(
    l2CacheUrl: string,
    table: string,
    l2Ids: string[],
  ) {
    const { fetchOkImpl } = this.httpSource;
    const repCoordinatesUrl = `${l2CacheUrl}/table/${table}/attributes`;
    const promise = fetchOkImpl(repCoordinatesUrl, {
      method: "POST",
      body: JSON.stringify({
        l2_ids: l2Ids,
      }),
    }).then((response) => response.json());
    return verifyObject(promise);
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
  ): Promise<number[][]> {
    const { l2CacheUrl, table } = this.info.app;
    const l2CacheAvailable =
      precisionMode && (await this.isL2CacheUrlAvailable());
    let { centroids, l2_path } = await this.graphServer.findPath(
      selectionInNanometers(first, annotationToNanometers),
      selectionInNanometers(second, annotationToNanometers),
      precisionMode && !l2CacheAvailable,
    );
    if (precisionMode && l2CacheAvailable && l2_path) {
      try {
        const attributes = await this.getAttributesForL2Ids(
          l2CacheUrl,
          table,
          l2_path,
        );
        // many reasons why an l2 id might not have info
        // l2 cache has a process that takes time for new ids (even hours)
        // maybe a small fraction have no info
        // sometime l2 is so small (single voxel), it is ignored by l2
        // best to just drop those points
        centroids = l2_path
          .map((id) => {
            return verifyOptionalObjectProperty(attributes, id, (x) => {
              return verifyIntegerArray(x["rep_coord_nm"]);
            });
          })
          .filter((x): x is number[] => x !== undefined);
      } catch (e) {
        console.error("centroids transform failed:", e);
      }
    }
    const centroidsTransformed = centroids.map((point: number[]) => {
      return point.map((val, i) => val / annotationToNanometers[i]);
    });
    return centroidsTransformed;
  }

  // Zetta Trace sits with the segment list rather than with the editing tools:
  // it is a mode that decides which segments are on screen, and a proofreader
  // driving it is reading the list, not reaching for multicut.
  segmentsTabContents(
    layer: SegmentationUserLayer,
    context: DependentViewContext,
  ) {
    const parent = document.createElement("div");
    parent.style.display = "contents";
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-segmentation-toolbox";
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_ZETTA_TRACE_TOOL_ID,
        label: "Zetta Trace",
        title: "Trace a segment through AI merge candidates",
      }),
    );
    parent.appendChild(toolbox);
    parent.appendChild(makeZettaTracePanel(layer, context));
    return parent;
  }

  tabContents(
    layer: SegmentationUserLayer,
    context: DependentViewContext,
    tab: SegmentationGraphSourceTab,
  ) {
    const parent = document.createElement("div");
    parent.style.display = "contents";
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-segmentation-toolbox";
    parent.appendChild(
      addLayerControlToOptionsTab(tab, layer, tab.visibility, timeControl),
    );
    parent.appendChild(
      addLayerControlToOptionsTab(
        tab,
        layer,
        tab.visibility,
        labeledTimestampControl,
      ),
    );
    parent.appendChild(
      addLayerControlToOptionsTab(tab, layer, tab.visibility, branchControl),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_MULTICUT_SEGMENTS_TOOL_ID,
        label: "Multicut",
        title: "Multicut segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_MERGE_SEGMENTS_TOOL_ID,
        label: "Merge",
        title: "Merge segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_FIND_PATH_TOOL_ID,
        label: "Find Path",
        title: "Find Path",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_PIECE_SPLIT_TOOL_ID,
        label: "Piece Split",
        title: "Split a piece using blue/red points",
      }),
    );
    parent.appendChild(toolbox);

    const segmentationGroupStateValue =
      layer.displayState.segmentationGroupState.value;
    const updateReadOnlyClass = () => {
      toolbox.classList.toggle(
        "calcada-time-travel-readonly",
        segmentationGroupStateValue.timestamp.value !== undefined,
      );
    };
    updateReadOnlyClass();
    context.registerDisposer(
      segmentationGroupStateValue.timestamp.changed.add(updateReadOnlyClass),
    );

    parent.appendChild(
      context.registerDisposer(
        new MulticutAnnotationLayerView(layer, layer.annotationDisplayState),
      ).element,
    );
    const tabElement = tab.element;
    tabElement.classList.add("neuroglancer-annotations-tab");
    tabElement.classList.add("neuroglancer-calcada-tab");
    return parent;
  }

  // following not used

  async merge(a: bigint, b: bigint): Promise<bigint> {
    a;
    b;
    return 0n;
  }

  async split(
    include: bigint,
    exclude: bigint,
  ): Promise<{ include: bigint; exclude: bigint }> {
    return { include, exclude };
  }

  trackSegment(
    _id: bigint,
    _callback: (id: bigint | null) => void,
  ): () => void {
    return () => {};
  }
}

class ChunkedGraphChunkSource
  extends SliceViewChunkSource
  implements ChunkedGraphChunkSourceInterface
{
  declare spec: ChunkedGraphChunkSpecification;
  declare OPTIONS: { spec: ChunkedGraphChunkSpecification };

  constructor(
    chunkManager: ChunkManager,
    options: {
      spec: ChunkedGraphChunkSpecification;
    },
  ) {
    super(chunkManager, options);
  }
}

class CalcadaChunkedGraphChunkSource extends WithParameters(
  WithSharedKvStoreContext(ChunkedGraphChunkSource),
  ChunkedGraphSourceParameters,
) {}

type ChunkedGraphLayerDisplayState = SegmentationDisplayState3D;

type TransformedChunkedGraphSource = FrontendTransformedSource<
  SliceViewRenderLayer,
  ChunkedGraphChunkSource
>;

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  source?: NestedStateManager<TransformedChunkedGraphSource>;
}

class SliceViewPanelChunkedGraphLayer extends SliceViewPanelRenderLayer {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  sharedObject: SegmentationLayerSharedObject;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;

  private leafRequestsActive: SharedWatchableValue<boolean>;
  private leafRequestsStatusMessage: StatusMessage | undefined;

  constructor(
    public chunkManager: ChunkManager,
    public source: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>,
    public displayState: ChunkedGraphLayerDisplayState,
    public localPosition: WatchableValueInterface<Float32Array>,
    nBitsForLayerId: number,
    branchId: WatchableValueInterface<number>,
  ) {
    super();
    this.leafRequestsActive = this.registerDisposer(
      SharedWatchableValue.make(chunkManager.rpc!, true),
    );
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        this.displayState.transform,
      ),
    );
    const sharedObject =
      (this.sharedObject =
      this.backend =
        this.registerDisposer(
          new SegmentationLayerSharedObject(
            chunkManager,
            displayState,
            this.layerChunkProgressInfo,
          ),
        ));
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.chunkSource.addCounterpartRef(),
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(
          chunkManager.rpc!,
          this.localPosition,
        ),
      ).rpcId,
      leafRequestsActive: this.leafRequestsActive.rpcId,
      nBitsForLayerId: this.registerDisposer(
        SharedWatchableValue.make(chunkManager.rpc!, nBitsForLayerId),
      ).rpcId,
      // Shared with backend so the chunked-graph layer can identify its
      // own chunks: CalcadaVolumeChunkSource.download filters layers by
      // matching branchId before applying a chunk's piece→root LUT.
      branchId: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(chunkManager.rpc!, branchId),
      ).rpcId,
    });
    this.registerDisposer(sharedObject.visibility.add(this.visibility));

    this.registerDisposer(
      this.leafRequestsActive.changed.add(() => {
        this.showOrHideMessage(this.leafRequestsActive.value);
      }),
    );
  }

  attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    super.attach(attachment);
    const chunkTransform = this.chunkTransform.value;
    const displayDimensionRenderInfo =
      attachment.view.displayDimensionRenderInfo.value;
    attachment.state = {
      chunkTransform,
      displayDimensionRenderInfo,
    };
    attachment.state!.source = attachment.registerDisposer(
      registerNested(
        (
          context: RefCounted,
          transform: RenderLayerTransformOrError,
          displayDimensionRenderInfo: DisplayDimensionRenderInfo,
        ) => {
          const transformedSources = getVolumetricTransformedSources(
            displayDimensionRenderInfo,
            transform,
            (_options) => [[this.source]],
            attachment.messages,
            this,
          ) as TransformedChunkedGraphSource[][];
          attachment.view.flushBackendProjectionParameters();
          this.sharedObject.rpc!.invoke(
            CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
            {
              layer: this.sharedObject.rpcId,
              view: attachment.view.rpcId,
              displayDimensionRenderInfo,
              sources: serializeAllTransformedSources(transformedSources),
            },
          );
          context;
          return transformedSources[0][0];
        },
        this.displayState.transform,
        attachment.view.displayDimensionRenderInfo,
      ),
    );
  }

  isReady() {
    return true;
  }

  private showOrHideMessage(leafRequestsActive: boolean) {
    if (this.leafRequestsStatusMessage && leafRequestsActive) {
      this.leafRequestsStatusMessage.dispose();
      this.leafRequestsStatusMessage = undefined;
      StatusMessage.showTemporaryMessage(
        "Loading chunked graph segmentation...",
        3000,
      );
    } else if (!this.leafRequestsStatusMessage && !leafRequestsActive) {
      this.leafRequestsStatusMessage = StatusMessage.showMessage(
        "At this zoom level, chunked graph segmentation will not be loaded. Please zoom in if you wish to load it.",
      );
    }
  }
}

const CALCADA_MULTICUT_SEGMENTS_TOOL_ID = "calcadaMulticutSegments";
const CALCADA_MERGE_SEGMENTS_TOOL_ID = "calcadaMergeSegments";
const CALCADA_FIND_PATH_TOOL_ID = "calcadaFindPath";
const CALCADA_PIECE_SPLIT_TOOL_ID = "calcadaPieceSplit";
const CALCADA_ZETTA_TRACE_TOOL_ID = "calcadaZettaTrace";

class MulticutAnnotationLayerView extends AnnotationLayerView {
  declare private _annotationStates: MergedAnnotationStates;
  constructor(
    public layer: SegmentationUserLayer,
    public displayState: AnnotationDisplayState,
  ) {
    super(layer, displayState);
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (graphConnection instanceof GraphConnection) {
      for (const state of graphConnection.annotationLayerStates) {
        this.annotationStates.add(state);
      }
    }
  }

  get annotationStates() {
    if (this._annotationStates === undefined) {
      this._annotationStates = this.registerDisposer(
        new MergedAnnotationStates(),
      );
    }
    return this._annotationStates;
  }
}

const addSelection = (
  source: AnnotationSource | MultiscaleAnnotationSource,
  selection: SegmentSelection,
  description?: string,
) => {
  const annotation: Point = {
    id: "",
    point: selection.position,
    type: AnnotationType.POINT,
    properties: [],
    relatedSegments: [BigUint64Array.of(selection.segmentId, selection.rootId)],
    description,
  };
  const ref = source.add(annotation);
  selection.annotationReference = ref;
};

const synchronizeAnnotationSource = (
  source: WatchableSet<SegmentSelection>,
  state: AnnotationLayerState,
) => {
  const annotationSource = state.source;
  annotationSource.childDeleted.add((annotationId) => {
    const selection = [...source].find(
      (selection) => selection.annotationReference?.id === annotationId,
    );
    if (selection) source.delete(selection);
  });

  source.changed.add((x, add) => {
    if (x === null) {
      for (const annotation of annotationSource) {
        annotationSource.delete(annotationSource.getReference(annotation.id));
      }
      return;
    }
    if (add) {
      addSelection(annotationSource, x);
    } else if (x.annotationReference) {
      annotationSource.delete(x.annotationReference);
    }
  });
  // load initial state
  for (const selection of source) {
    addSelection(annotationSource, selection);
  }
};

function getMousePositionInLayerCoordinates(
  unsnappedPosition: Float32Array,
  layer: SegmentationUserLayer,
): Float32Array | undefined {
  const loadedSubsource = getGraphLoadedSubsource(layer)!;
  const modelTransform = loadedSubsource.getRenderLayerTransform();
  const chunkTransform = makeValueOrError(() =>
    getChunkTransformParameters(valueOrThrow(modelTransform.value)),
  );
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(
    chunkTransform.modelTransform.unpaddedRank,
  );
  if (
    !getChunkPositionFromCombinedGlobalLocalPositions(
      chunkPosition,
      unsnappedPosition,
      layer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    )
  ) {
    return undefined;
  }
  return chunkPosition;
}

const getPoint = (
  layer: SegmentationUserLayer,
  mouseState: MouseSelectionState,
) => {
  if (mouseState.updateUnconditionally()) {
    return getMousePositionInLayerCoordinates(
      mouseState.unsnappedPosition,
      layer,
    );
  }
  return undefined;
};

// Legacy value kept verbatim: this is the persisted tool id in saved NG
// states, and renaming it would break every state with a timestamp tool.
const CALCADA_TIME_JSON_KEY = "grapheneTime";

const timeControl = {
  label: "Time",
  title: "View segmentation at earlier point of time",
  toolJson: CALCADA_TIME_JSON_KEY,
  ...timeLayerControl(),
};

registerLayerControl(SegmentationUserLayer, timeControl);

const CALCADA_LABELED_TIMESTAMP_JSON_KEY = "calcadaLabeledTimestamp";
const LABELED_TIMESTAMP_CONTROL_TITLE =
  "Labeled timestamps for the current branch. Selecting one switches the view to that point in time (read-only).";

const labeledTimestampControl = {
  label: "Label",
  title: LABELED_TIMESTAMP_CONTROL_TITLE,
  toolJson: CALCADA_LABELED_TIMESTAMP_JSON_KEY,
  ...labeledTimestampLayerControl(),
};

registerLayerControl(SegmentationUserLayer, labeledTimestampControl);

function branchLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const segmentationGroupState =
        layer.displayState.segmentationGroupState.value;
      const {
        graph: { value: graph },
      } = segmentationGroupState;
      const branchId =
        graph instanceof CalcadaGraphSource
          ? graph.branchId
          : new TrackableValue<number>(0, (x) => x);

      const controlElement = document.createElement("div");
      controlElement.classList.add("neuroglancer-calcada-branch-control");

      const select = document.createElement("select");
      select.classList.add("neuroglancer-layer-control-control");
      select.title =
        "Calcada branch (main = 0). Switching clears segments not present on the new branch.";

      const renderOptions = () => {
        const branches =
          graph instanceof CalcadaGraphSource ? graph.branches.value : [];
        while (select.firstChild) {
          select.removeChild(select.firstChild);
        }
        const mainOption = document.createElement("option");
        mainOption.value = "0";
        mainOption.textContent = "main";
        select.appendChild(mainOption);
        // Show active and creating branches in the dropdown; creating
        // branches are disabled until their copy completes. Other
        // non-active branches (merged/abandoned) are hidden unless the
        // layer state points at one of them — restoring such state without
        // that option would leave the select stuck on "main" even though
        // branchId.value is set, making it look like state restore didn't
        // work.
        const selectedId = branchId.value;
        for (const { id, name, status, parentId } of branches) {
          const isActive = status === "active";
          const isCreating = status === "creating";
          if (!isActive && !isCreating && id !== selectedId) continue;
          const opt = document.createElement("option");
          opt.value = String(id);
          if (isCreating) {
            opt.textContent = `${name} (creating…)`;
          } else if (!isActive) {
            opt.textContent = `${name} (${status})`;
          } else if (parentId !== 0) {
            const parentName =
              branches.find((branch) => branch.id === parentId)?.name ??
              `#${parentId}`;
            opt.textContent = `${name} ← ${parentName}`;
          } else {
            opt.textContent = name;
          }
          opt.disabled = isCreating;
          select.appendChild(opt);
        }
        select.value = String(selectedId);
      };
      renderOptions();

      select.addEventListener("change", () => {
        const parsed = Number.parseInt(select.value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          select.value = String(branchId.value);
          return;
        }
        if (parsed === branchId.value) return;
        const targetBranch =
          graph instanceof CalcadaGraphSource
            ? graph.branches.value.find((branch) => branch.id === parsed)
            : undefined;
        if (targetBranch !== undefined && targetBranch.status === "creating") {
          select.value = String(branchId.value);
          return;
        }
        // Drop selected segments synchronously before switching — the
        // branchId.changed listener also clears, but doing it here too
        // suppresses the "Could not fetch root: piece not found" spam
        // that would otherwise fire from any in-flight selectedSegments
        // changes referencing pieces local to the previous branch.
        segmentationGroupState.selectedSegments.clear();
        segmentationGroupState.visibleSegments.clear();
        segmentationGroupState.segmentEquivalences.clear();
        branchId.value = parsed;
      });

      select.addEventListener("focus", () => {
        if (graph instanceof CalcadaGraphSource) {
          graph.triggerBranchRefresh();
        }
      });

      const sync = () => {
        // Re-render so a non-active branch becomes a visible option when
        // branchId points at it; otherwise the select silently falls back
        // to "main" because the matching <option> doesn't exist.
        renderOptions();
      };
      context.registerDisposer(branchId.changed.add(sync));
      if (graph instanceof CalcadaGraphSource) {
        context.registerDisposer(graph.branches.changed.add(renderOptions));
      }
      controlElement.appendChild(select);

      const newBranchButton = document.createElement("button");
      newBranchButton.type = "button";
      newBranchButton.textContent = "+ New branch";
      controlElement.appendChild(newBranchButton);

      const createForm = document.createElement("div");
      createForm.style.display = "none";
      const parentSelect = document.createElement("select");
      parentSelect.name = "parent_branch";
      // resetToDefault distinguishes "form just opened" (jump to the
      // default parent) from "branches list refreshed under an open form"
      // (keep whatever the user already picked, unless that option is gone).
      const renderParentOptions = (resetToDefault: boolean) => {
        const previousValue = parentSelect.value;
        parentSelect.textContent = "";
        const mainOption = document.createElement("option");
        mainOption.value = "0";
        mainOption.textContent = "from: main";
        parentSelect.appendChild(mainOption);
        const branches =
          graph instanceof CalcadaGraphSource ? graph.branches.value : [];
        for (const { id, name, status } of branches) {
          if (status !== "active") continue;
          const option = document.createElement("option");
          option.value = String(id);
          option.textContent = `from: ${name}`;
          parentSelect.appendChild(option);
        }
        const defaultValue = String(
          graph instanceof CalcadaGraphSource
            ? defaultParentForNewBranch(graph)
            : 0,
        );
        parentSelect.value = resetToDefault ? defaultValue : previousValue;
        if (parentSelect.selectedIndex === -1) {
          parentSelect.value = defaultValue;
        }
        if (parentSelect.selectedIndex === -1) parentSelect.value = "0";
      };
      renderParentOptions(true);
      if (graph instanceof CalcadaGraphSource) {
        context.registerDisposer(
          graph.branches.changed.add(() => renderParentOptions(false)),
        );
      }
      createForm.appendChild(parentSelect);
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.name = "branch_name";
      const createButton = document.createElement("button");
      createButton.type = "submit";
      createButton.textContent = "Create";
      const errorSpan = document.createElement("span");
      errorSpan.className = "branch-create-error";
      createForm.appendChild(nameInput);
      createForm.appendChild(createButton);
      createForm.appendChild(errorSpan);
      controlElement.appendChild(createForm);

      newBranchButton.addEventListener("click", () => {
        const isHidden = createForm.style.display === "none";
        createForm.style.display = isHidden ? "" : "none";
        if (isHidden) {
          renderParentOptions(true);
          nameInput.focus();
        }
      });

      const submitCreate = async () => {
        if (!(graph instanceof CalcadaGraphSource)) return;
        const name = String(nameInput.value).trim();
        if (name.length === 0) return;
        const originBranchId = graph.branchId.value;
        createButton.disabled = true;
        try {
          let response: Response;
          const parsedParentId = Number.parseInt(parentSelect.value, 10);
          const resolvedParentId = Number.isFinite(parsedParentId)
            ? parsedParentId
            : defaultParentForNewBranch(graph);
          try {
            response = await graph.createBranch(name, resolvedParentId);
          } catch (e: any) {
            const resp: Response | undefined = e?.response;
            let msg = "";
            if (resp) {
              try {
                const errBody = await resp.json();
                msg = errBody?.error || errBody?.message || "";
              } catch {
                msg = "";
              }
              if (!msg) msg = `${resp.status} ${resp.statusText}`;
            } else {
              msg = e instanceof Error ? e.message : String(e);
            }
            errorSpan.textContent = msg;
            return;
          }
          let body: any = {};
          try {
            body = await response.json();
          } catch {
            body = {};
          }
          const newId = body?.branch_id;
          const newName = body?.branch_name;
          if (typeof newId !== "number" || typeof newName !== "string") {
            errorSpan.textContent = "Invalid response from server";
            return;
          }
          const newStatus =
            typeof body?.status === "string" ? body.status : "active";
          graph.branches.value = [
            ...graph.branches.value,
            {
              id: newId,
              name: newName,
              status: newStatus,
              parentId: resolvedParentId,
            },
          ];
          if (newStatus === "active") {
            graph.branchId.value = newId;
          } else {
            let cancelled = false;
            context.registerDisposer(() => {
              cancelled = true;
            });
            watchBranchUntilActive(
              graph,
              newId,
              originBranchId,
              () => cancelled,
            );
          }
          nameInput.value = "";
          createForm.style.display = "none";
          errorSpan.textContent = "";
          graph.triggerBranchRefresh();
        } finally {
          createButton.disabled = false;
        }
      };

      createButton.addEventListener("click", (e) => {
        e.preventDefault();
        submitCreate();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitCreate();
        }
      });

      const diffLink = document.createElement("a");
      diffLink.className = "calcada-open-diff";
      diffLink.textContent = "Open diff";
      diffLink.target = "_blank";
      diffLink.rel = "noopener";
      controlElement.appendChild(diffLink);

      const updateDiffLink = () => {
        if (!(graph instanceof CalcadaGraphSource)) {
          diffLink.style.display = "none";
          return;
        }
        // segmentationUrl may carry a "middleauth+" scheme prefix from the
        // kvstore parser; strip it before passing to new URL() so .origin
        // yields a plain https:// URL the browser can navigate to.
        const rawUrl = graph.info.app!.segmentationUrl.replace(
          /^middleauth\+/,
          "",
        );
        const adminOrigin = new URL(rawUrl).origin;
        diffLink.href = `${adminOrigin}/admin/graphs/${graph.info.app!.table}/branches/${branchId.value}/diff`;
        diffLink.style.display = branchId.value === 0 ? "none" : "";
      };
      updateDiffLink();
      context.registerDisposer(branchId.changed.add(updateDiffLink));

      return { controlElement, control: select };
    },
    activateTool: (_activation) => {},
  };
}

const branchControl = {
  label: "Branch",
  title: "Calcada branch (0 = main)",
  toolJson: CALCADA_BRANCH_JSON_KEY,
  ...branchLayerControl(),
};

registerLayerControl(SegmentationUserLayer, branchControl);

// Shared between the Time date-picker and the Label dropdown: widgets write
// the value they WANT into intermediateTimestamp; the guard below either
// commits it to segmentsState.timestamp (after confirming the segment clear)
// or snaps it back when the timestamp is locked.
function makeGuardedTimestampState(
  layer: SegmentationUserLayer,
  context: RefCounted,
) {
  const segmentationGroupState =
    layer.displayState.segmentationGroupState.value;
  const {
    graph: { value: graph },
  } = segmentationGroupState;
  const timestamp =
    graph instanceof CalcadaGraphSource
      ? segmentationGroupState.timestamp
      : new WatchableValue<number | undefined>(undefined);
  const timestampOwner =
    graph instanceof CalcadaGraphSource
      ? segmentationGroupState.timestampOwner
      : new WatchableSet<string>();
  const intermediateTimestamp = new WatchableValue<number | undefined>(
    timestamp.value,
  );
  intermediateTimestamp.changed.add(async () => {
    if (intermediateTimestamp.value === timestamp.value) {
      return;
    }
    // resetting timestamp back to unset
    if (
      intermediateTimestamp.value === undefined &&
      segmentationGroupState.canSetTimestamp(layer.managedLayer.name)
    ) {
      timestamp.value = intermediateTimestamp.value;
      timestampOwner.delete(layer.managedLayer.name);
      return;
    }
    if (graph instanceof CalcadaGraphSource) {
      const selfLock = segmentationGroupState.timestampOwner.has(
        layer.managedLayer.name,
      );
      const canSetTimestamp = segmentationGroupState.canSetTimestamp(
        layer.managedLayer.name,
      );
      // if we have a lock while the timestamp is unset, it is a tool-based lock (this check can be improved)
      if (canSetTimestamp && (!selfLock || timestamp.value !== undefined)) {
        const nonLatestRoots = await graph.graphServer.filterLatestRoots(
          [...segmentationGroupState.selectedSegments],
          timestamp.value,
          true,
          graph.branchId.value,
        );
        if (
          !nonLatestRoots.length ||
          confirm(
            `Changing calcada time will clear ${nonLatestRoots.length} segment(s).`,
          )
        ) {
          timestamp.value = intermediateTimestamp.value;
          // is this where it is done
          timestampOwner.add(layer.managedLayer.name);
          return;
        }
      }
      intermediateTimestamp.value = timestamp.value;
      StatusMessage.showTemporaryMessage("Timestamp is locked.");
    }
  });
  context.registerDisposer(
    timestamp.changed.add(() => {
      if (timestamp.value !== intermediateTimestamp.value) {
        intermediateTimestamp.value = timestamp.value;
      }
    }),
  );
  return { graph, timestamp, intermediateTimestamp };
}

function timeLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const { graph, intermediateTimestamp } = makeGuardedTimestampState(
        layer,
        context,
      );
      const timestampLimit =
        graph instanceof CalcadaGraphSource
          ? graph.timestampLimit
          : new WatchableValue<number>(0);

      const controlElement = document.createElement("div");
      controlElement.classList.add("neuroglancer-time-control");
      const widget = context.registerDisposer(
        new DateTimeInputWidget(
          intermediateTimestamp,
          new Date(timestampLimit.value),
          new Date(),
        ),
      );
      timestampLimit.changed.add(() => {
        widget.setMin(new Date(timestampLimit.value));
      });
      controlElement.appendChild(widget.element);
      return { controlElement, control: widget };
    },
    activateTool: (_activation) => {},
  };
}

function labeledTimestampLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const { graph, intermediateTimestamp } = makeGuardedTimestampState(
        layer,
        context,
      );

      const controlElement = document.createElement("div");
      controlElement.classList.add(
        "neuroglancer-calcada-labeled-timestamp-control",
      );
      const labelSelect = document.createElement("select");
      labelSelect.classList.add("neuroglancer-layer-control-control");
      labelSelect.title = LABELED_TIMESTAMP_CONTROL_TITLE;
      const LIVE_VALUE = "";
      const renderLabelOptions = () => {
        const labels =
          graph instanceof CalcadaGraphSource
            ? graph.labeledTimestamps.value
            : [];
        while (labelSelect.firstChild) {
          labelSelect.removeChild(labelSelect.firstChild);
        }
        const liveOption = document.createElement("option");
        liveOption.value = LIVE_VALUE;
        liveOption.textContent = "— live —";
        labelSelect.appendChild(liveOption);
        for (const { id, label, timestampMs, visibility } of labels) {
          const option = document.createElement("option");
          option.value = String(timestampMs);
          option.dataset.labelId = id;
          option.textContent =
            visibility === "admin" ? `${label} (admins)` : label;
          labelSelect.appendChild(option);
        }
        // Reflect the PENDING value: on a rejected switch the guard snaps
        // intermediateTimestamp back, which re-renders the select to reality.
        const currentTimestamp = intermediateTimestamp.value;
        const match =
          currentTimestamp === undefined
            ? undefined
            : labels.find(
                (candidate) => candidate.timestampMs === currentTimestamp,
              );
        labelSelect.value = match ? String(match.timestampMs) : LIVE_VALUE;
      };
      renderLabelOptions();

      labelSelect.addEventListener("change", () => {
        intermediateTimestamp.value =
          labelSelect.value === LIVE_VALUE
            ? undefined
            : Number.parseInt(labelSelect.value, 10);
      });
      labelSelect.addEventListener("focus", () => {
        if (graph instanceof CalcadaGraphSource) {
          graph.triggerLabeledTimestampRefresh();
        }
      });

      context.registerDisposer(
        intermediateTimestamp.changed.add(renderLabelOptions),
      );
      if (graph instanceof CalcadaGraphSource) {
        context.registerDisposer(
          graph.labeledTimestamps.changed.add(renderLabelOptions),
        );
      }
      controlElement.appendChild(labelSelect);
      return { controlElement, control: labelSelect };
    },
    activateTool: (_activation) => {},
  };
}

const checkSegmentationOld = (
  timestamp: WatchableValue<number | undefined>,
  activation: ToolActivation,
) => {
  if (timestamp.value !== undefined) {
    StatusMessage.showTemporaryMessage(
      "Editing can not be performed with a segmentation at an older state.",
    );
    activation.cancel();
    return true;
  }
  return false;
};

const MULTICUT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+control+mousedown0": { action: "set-anchor" },
  "at:shift?+keyg": { action: "swap-group" },
  "at:shift?+enter": { action: "submit" },
  "at:control+keyz": { action: "undo" },
});

class MulticutSegmentsTool extends LayerTool<SegmentationUserLayer> {
  toJSON() {
    return CALCADA_MULTICUT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { multicutState },
      segmentsState,
    } = graphConnection;
    if (multicutState === undefined) return;
    if (checkSegmentationOld(segmentsState.timestamp, activation)) {
      return;
    }

    // When focus segment is set, enter split mode to show pieces.
    // Watch for focusSegment changes to trigger split mode.
    const splitModeDisposer = multicutState.focusSegment.changed.add(() => {
      const focus = multicutState.focusSegment.value;
      if (focus !== undefined) {
        graphConnection.enterSplitMode(focus);
      }
    });
    // If focus segment already set (e.g. restored from state), enter immediately
    if (multicutState.focusSegment.value !== undefined) {
      graphConnection.enterSplitMode(multicutState.focusSegment.value);
    }
    activation.registerDisposer(() => {
      splitModeDisposer();
      graphConnection.exitSplitMode();
    });

    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Multicut segments";
    body.classList.add("calcada-tool-status", "calcada-multicut");
    body.appendChild(
      makeIcon({
        text: "Swap",
        title: "Swap group",
        onClick: () => {
          multicutState.swapGroup();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear multicut",
        onClick: () => {
          multicutState.reset();
        },
      }),
    );
    const submitAction = async () => {
      submitIcon.classList.toggle("disabled", true);
      const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
      const annotationToNanometers =
        loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
          (x) => x / 1e-9,
        );
      graphConnection.submitMulticut(annotationToNanometers).then((success) => {
        submitIcon.classList.toggle("disabled", false);
        if (success) {
          activation.cancel();
        }
      });
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit multicut",
      onClick: () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    const activeGroupIndicator = document.createElement("div");
    activeGroupIndicator.className = "activeGroupIndicator";
    activeGroupIndicator.innerHTML = "Active Group: ";
    body.appendChild(activeGroupIndicator);

    const { displayState } = this.layer;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = displayState.segmentationGroupState.value;
    const priorBaseSegmentHighlighting =
      displayState.baseSegmentHighlighting.value;
    const priorHighlightColor = displayState.highlightColor.value;
    const priorHideSegmentZero = displayState.hideSegmentZero.value;

    activation.bindInputEventMap(MULTICUT_SEGMENTS_INPUT_EVENT_MAP);
    activation.bindAction("undo", (event) => {
      event.stopPropagation();
      void graphConnection.undo();
    });
    activation.registerDisposer(() => {
      resetMulticutDisplay();
      displayState.baseSegmentHighlighting.value = priorBaseSegmentHighlighting;
      displayState.highlightColor.value = priorHighlightColor;
      displayState.hideSegmentZero.value = priorHideSegmentZero;
    });
    const resetMulticutDisplay = () => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.useTempSegmentStatedColors2d.value = false;
      displayState.tempSegmentStatedColors2d.value.clear(); // TODO, should only clear those that are in temp sets
      displayState.tempSegmentDefaultColor2d.value = undefined;
      displayState.highlightColor.value = undefined;
    };
    const updateMulticutDisplay = () => {
      resetMulticutDisplay();
      activeGroupIndicator.classList.toggle(
        "blueGroup",
        multicutState.blueGroup.value,
      );
      const focusSegment = multicutState.focusSegment.value;
      if (focusSegment === undefined) return;
      displayState.baseSegmentHighlighting.value = true;
      displayState.highlightColor.value = multicutState.blueGroup.value
        ? BLUE_COLOR_HIGHTLIGHT
        : RED_COLOR_HIGHLIGHT;
      displayState.hideSegmentZero.value = false;
      segmentsState.useTemporaryVisibleSegments.value = true;
      segmentsState.useTemporarySegmentEquivalences.value = true;
      // add focus segment and red/blue segments
      segmentsState.temporaryVisibleSegments.add(focusSegment);
      for (const segment of multicutState.segments) {
        segmentsState.temporaryVisibleSegments.add(segment);
      }
      // all other segments are added to the focus segment equivalences
      for (const equivalence of segmentsState.segmentEquivalences.setElements(
        focusSegment,
      )) {
        if (!segmentsState.temporaryVisibleSegments.has(equivalence)) {
          segmentsState.temporarySegmentEquivalences.link(
            focusSegment,
            equivalence,
          );
        }
      }
      // set colors
      displayState.tempSegmentDefaultColor2d.value = MULTICUT_OFF_COLOR;
      displayState.tempSegmentStatedColors2d.value.set(
        focusSegment,
        TRANSPARENT_COLOR_PACKED,
      );
      for (const segment of multicutState.redSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          RED_COLOR_SEGMENT_PACKED,
        );
      }
      for (const segment of multicutState.blueSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          BLUE_COLOR_SEGMENT_PACKED,
        );
      }

      displayState.useTempSegmentStatedColors2d.value = true;
    };
    updateMulticutDisplay();
    activation.registerDisposer(
      multicutState.changed.add(updateMulticutDisplay),
    );
    activation.registerDisposer(
      segmentationGroupState.segmentEquivalences.changed.add(
        debounce(() => updateMulticutDisplay(), 0),
      ),
    );
    activation.bindAction("swap-group", (event) => {
      event.stopPropagation();
      multicutState.swapGroup();
    });
    activation.bindAction("set-anchor", (event) => {
      event.stopPropagation();
      const currentSegmentSelection = maybeGetSelection(
        this,
        segmentationGroupState.visibleSegments,
      );
      if (!currentSegmentSelection) return;
      const { rootId, segmentId } = currentSegmentSelection;
      const { focusSegment, segments } = multicutState;
      if (focusSegment.value === undefined) {
        focusSegment.value = rootId;
      }
      if (focusSegment.value !== rootId) {
        StatusMessage.showTemporaryMessage(
          `The selected piece has root segment ${rootId}, but the pieces already selected have root ${focusSegment.value}`,
          12000,
        );
        return;
      }
      const isRoot = rootId === segmentId;
      if (!isRoot) {
        for (const segment of segments) {
          if (segment === segmentId) {
            StatusMessage.showTemporaryMessage(
              `Piece ${segmentId} has already been selected`,
              7000,
            );
            return;
          }
        }
      }
      multicutState.activeGroup.add(currentSegmentSelection);
    });
    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
  }

  get description() {
    return "multicut";
  }
}

// Takes the two things it actually reads rather than a tool, so a mode that has
// no tool activation can ask the same question. LayerTool satisfies this shape
// structurally, so its call sites are unchanged.
/**
 * The Zetta Trace panel, shown in the Graph tab while the mode is on.
 *
 * It lives in the tab rather than in a tool-activation status bubble because
 * the mode outlives any tool: a proofreader who picks up the cut tool to clean
 * up a candidate must still see which candidate they are on, and still be able
 * to answer it.
 */
function makeZettaTracePanel(
  layer: SegmentationUserLayer,
  context: DependentViewContext,
) {
  const panel = document.createElement("div");
  panel.className = "calcada-zetta-trace";

  const header = document.createElement("div");
  header.className = "calcada-zetta-trace-header";
  const badge = document.createElement("span");
  badge.className = "calcada-zetta-trace-badge";
  badge.textContent = "Trace mode";
  header.appendChild(badge);
  panel.appendChild(header);

  const status = document.createElement("div");
  status.className = "calcada-zetta-trace-status";
  panel.appendChild(status);

  const sizeRow = document.createElement("label");
  sizeRow.className = "calcada-zetta-trace-size";
  sizeRow.textContent = "Min candidate size";
  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.min = "0";
  sizeInput.step = "100";
  sizeInput.title =
    "Skip candidates whose piece is smaller than this many voxels";
  sizeRow.appendChild(sizeInput);
  panel.appendChild(sizeRow);

  // Proofreaders disagree, so whose rejections count is a setting rather than a
  // rule. "me" is sent verbatim — the server resolves it, because the browser
  // has an opaque token and no idea who it belongs to.
  const rejectedRow = document.createElement("label");
  rejectedRow.className = "calcada-zetta-trace-size";
  rejectedRow.textContent = "Skip rejected by";
  const rejectedSelect = document.createElement("select");
  for (const [value, label] of [
    ["anyone", "anyone"],
    ["me", "only me"],
    ["custom", "me and…"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    rejectedSelect.appendChild(option);
  }
  rejectedRow.appendChild(rejectedSelect);
  panel.appendChild(rejectedRow);

  const rejectedUsers = document.createElement("input");
  rejectedUsers.type = "text";
  rejectedUsers.placeholder = "tommy@zetta.ai, …";
  rejectedUsers.title =
    "Comma-separated users whose rejections to skip as well";
  rejectedUsers.className = "calcada-zetta-trace-users";
  panel.appendChild(rejectedUsers);

  const buttons = document.createElement("div");
  buttons.className = "calcada-zetta-trace-buttons";
  panel.appendChild(buttons);

  const session = () => {
    const { value: connection } = layer.graphConnection;
    return connection instanceof GraphConnection ? connection : undefined;
  };

  const exitIcon = makeIcon({
    text: "Exit",
    title: "Leave trace mode (Esc)",
    onClick: () => {
      const traceState = session()?.state.zettaTraceState;
      if (traceState !== undefined) traceState.active.value = false;
    },
  });
  header.appendChild(exitIcon);

  const rejectIcon = makeIcon({
    text: "Reject",
    title: "Reject this candidate (left arrow)",
    onClick: () => session()?.traceSession.reject(),
  });
  const skipIcon = makeIcon({
    text: "Skip",
    title: "Skip for now, this session only (down arrow)",
    onClick: () => session()?.traceSession.skip(),
  });
  const acceptIcon = makeIcon({
    text: "Accept",
    title: "Accept and merge (right arrow)",
    onClick: () => void session()?.traceSession.accept(),
  });
  const undoIcon = makeIcon({
    text: "Undo",
    title: "Take back the last edit (⌘/ctrl+Z)",
    onClick: () => void session()?.traceSession.undoLast(),
  });
  buttons.appendChild(rejectIcon);
  buttons.appendChild(skipIcon);
  buttons.appendChild(acceptIcon);
  buttons.appendChild(undoIcon);

  const render = () => {
    const connection = session();
    const traceState = connection?.state.zettaTraceState;
    const active = traceState?.active.value === true;
    panel.style.display = active ? "" : "none";
    if (!active || connection === undefined) return;
    status.textContent = connection.traceSession.status;
    if (document.activeElement !== sizeInput) {
      sizeInput.value = String(traceState!.minPieceVoxels.value);
    }
    const rejected = traceState!.rejectedBy.value;
    const extra = rejected.filter((user) => user !== TRACE_CURRENT_USER);
    if (document.activeElement !== rejectedSelect) {
      rejectedSelect.value =
        rejected.length === 0 ? "anyone" : extra.length > 0 ? "custom" : "me";
    }
    rejectedUsers.style.display =
      rejectedSelect.value === "custom" ? "" : "none";
    if (document.activeElement !== rejectedUsers) {
      rejectedUsers.value = extra.join(", ");
    }
    const busy = connection.traceSession.isBusy;
    const noCandidate = connection.traceSession.current === undefined;
    for (const icon of [rejectIcon, skipIcon, acceptIcon]) {
      icon.classList.toggle("disabled", busy || noCandidate);
    }
    // Undo stays live with no candidate on screen: running out of candidates is
    // exactly when someone notices the last merge was wrong.
    undoIcon.classList.toggle("disabled", busy || !connection.canUndo());
  };

  const applyRejectedBy = () => {
    const traceState = session()?.state.zettaTraceState;
    if (traceState === undefined) return;
    const mode = rejectedSelect.value;
    if (mode === "anyone") {
      traceState.rejectedBy.value = [];
      return;
    }
    const extra =
      mode === "custom"
        ? rejectedUsers.value
            .split(",")
            .map((user) => user.trim())
            .filter((user) => user.length > 0)
        : [];
    traceState.rejectedBy.value = [TRACE_CURRENT_USER, ...extra];
  };
  rejectedSelect.addEventListener("change", applyRejectedBy);
  rejectedUsers.addEventListener("change", applyRejectedBy);

  sizeInput.addEventListener("change", () => {
    const traceState = session()?.state.zettaTraceState;
    if (traceState === undefined) return;
    const parsed = Number.parseInt(sizeInput.value, 10);
    traceState.minPieceVoxels.value =
      Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  });

  // The connection is rebuilt when the data source reloads, so the listeners
  // are re-attached rather than bound once at construction.
  const attachTo = new Map<GraphConnection, () => void>();
  const syncListeners = () => {
    const connection = session();
    if (connection !== undefined && !attachTo.has(connection)) {
      const dispose = [
        connection.traceSession.changed.add(render),
        connection.state.zettaTraceState.changed.add(render),
      ];
      attachTo.set(connection, () => dispose.forEach((fn) => fn()));
      context.registerDisposer(() => attachTo.get(connection)?.());
    }
    render();
  };
  context.registerDisposer(layer.graphConnection.changed.add(syncListeners));
  syncListeners();

  return panel;
}

const maybeGetSelection = (
  source: { layer: SegmentationUserLayer; mouseState: MouseSelectionState },
  visibleSegments: Uint64Set,
): SegmentSelection | undefined => {
  const { layer, mouseState } = source;
  const {
    segmentSelectionState: { value, baseValue },
  } = layer.displayState;
  if (!baseValue || !value) return;
  if (!visibleSegments.has(value)) {
    StatusMessage.showTemporaryMessage(
      "The selected piece is of an unselected segment",
      7000,
    );
    return;
  }
  const point = getPoint(layer, mouseState);
  if (point === undefined) return;
  return {
    rootId: value,
    segmentId: baseValue,
    position: point,
  };
};

interface MergeSubmission {
  id: string;
  locked: boolean;
  error?: string;
  status?: string;
  sink: SegmentSelection;
  source?: SegmentSelection;
  mergedRoot?: bigint;
}

export class MergeSegmentsPlaceLineTool extends PlaceLineTool {
  getBaseSegment = true;
  constructor(
    layer: SegmentationUserLayer,
    private annotationState: AnnotationLayerState,
  ) {
    super(layer, {});
    const { inProgressAnnotation } = this;
    const { displayState } = annotationState;
    if (!displayState) return; // TODO, this happens when reloading the page when a toggle tool is up
    const { disablePicking } = displayState;
    this.registerDisposer(
      inProgressAnnotation.changed.add(() => {
        disablePicking.value = inProgressAnnotation.value !== undefined;
      }),
    );
  }
  get annotationLayer() {
    return this.annotationState;
  }
  get description() {
    return "merge line";
  }
  toJSON() {
    return ANNOTATE_MERGE_LINE_TOOL_ID;
  }
}

function lineToSubmission(line: Line, pending: boolean): MergeSubmission {
  const relatedSegments = line.relatedSegments![0];
  const res: MergeSubmission = {
    id: line.id,
    locked: false,
    sink: {
      position: line.pointA.slice(),
      rootId: relatedSegments[0],
      segmentId: relatedSegments[1],
    },
  };
  if (!pending) {
    res.source = {
      position: line.pointB.slice(),
      rootId: relatedSegments[2],
      segmentId: relatedSegments[3],
    };
  }
  return res;
}

function mergeToLine(submission: MergeSubmission): Line {
  const { sink, source } = submission;
  const res: Line = {
    id: submission.id,
    type: AnnotationType.LINE,
    pointA: sink.position.slice(),
    pointB: source!.position.slice(),
    relatedSegments: [
      BigUint64Array.of(
        sink.rootId,
        sink.segmentId,
        source!.rootId,
        source!.segmentId,
      ),
    ],
    properties: [],
  };
  return res;
}

const MAX_MERGE_COUNT = 20;

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
  "at:control+keyz": { action: "undo" },
});

class MergeSegmentsTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const {
      graphConnection: { value: graphConnection },
      tool,
    } = this.layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) {
      activation.cancel();
      return;
    }
    const {
      state: { mergeState },
      segmentsState: { timestamp },
      mergeAnnotationState,
    } = graphConnection;
    if (checkSegmentationOld(timestamp, activation)) {
      return;
    }
    const { merges, autoSubmit } = mergeState;
    const lineTool = new MergeSegmentsPlaceLineTool(
      this.layer,
      mergeAnnotationState,
    );
    tool.value = lineTool;
    activation.registerDisposer(() => {
      tool.value = undefined;
    });
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Merge segments";
    body.classList.add("calcada-tool-status", "calcada-merge-segments");
    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    activation.bindAction("undo", (event) => {
      event.stopPropagation();
      void graphConnection.undo();
    });
    const submitAction = async () => {
      if (merges.value.filter((x) => x.locked).length) return;
      submitIcon.classList.toggle("disabled", true);
      await graphConnection.bulkMerge(merges.value);
      submitIcon.classList.toggle("disabled", false);
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit merge",
      onClick: async () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    activation.bindAction("submit", async (event) => {
      event.stopPropagation();
      submitAction();
    });
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear pending merges",
        onClick: () => {
          lineTool.deactivate();
          for (const merge of merges.value) {
            if (!merge.locked) {
              graphConnection.deleteMergeSubmission(merge);
            }
          }
        },
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(autoSubmit),
    );
    const label = document.createElement("label");
    label.appendChild(document.createTextNode("auto-submit"));
    label.title = "auto-submit merges";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const points = document.createElement("div");
    points.classList.add("calcada-merge-segments-merges");
    body.appendChild(points);

    const segmentWidgetFactory = SegmentWidgetFactory.make(
      this.layer.displayState,
      /*includeUnmapped=*/ true,
    );
    const makeWidget = (id: Uint64MapEntry) => {
      const row = segmentWidgetFactory.getWithNormalizedId(id);
      row.classList.add("neuroglancer-segment-list-entry-double-line");
      return row;
    };

    const createPointElement = (id: bigint) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("calcada-merge-segments-point");
      const widget = makeWidget(augmentSegmentId(this.layer.displayState, id));
      containerEl.appendChild(widget);
      return containerEl;
    };

    const createSubmissionElement = (submission: MergeSubmission) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("calcada-merge-segments-submission");
      containerEl.appendChild(createPointElement(submission.sink.rootId));
      if (submission.source) {
        containerEl.appendChild(document.createElement("div")).textContent =
          "ꕹ";
        containerEl.appendChild(createPointElement(submission.source.rootId));
      }
      if (!submission.locked) {
        containerEl.appendChild(
          makeDeleteButton({
            title: "Delete merge",
            onClick: (event) => {
              event.stopPropagation();
              event.preventDefault();
              graphConnection.deleteMergeSubmission(submission);
            },
          }),
        );
      }
      if (submission.status) {
        const statusEl = document.createElement("div");
        statusEl.classList.add("calcada-merge-segments-submission-status");
        statusEl.textContent = submission.status;
        containerEl.appendChild(statusEl);
      }
      return containerEl;
    };

    const updateUI = () => {
      while (points.firstChild) {
        points.removeChild(points.firstChild);
      }
      for (const submission of merges.value) {
        points.appendChild(createSubmissionElement(submission));
      }
    };
    activation.registerDisposer(merges.changed.add(updateUI));
    updateUI();
  }

  toJSON() {
    return CALCADA_MERGE_SEGMENTS_TOOL_ID;
  }

  get description() {
    return "merge segments";
  }
}

const FIND_PATH_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
  "at:shift?+control+mousedown0": { action: "add-point" },
});

class FindPathTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { findPathState },
      findPathAnnotationState,
    } = graphConnection;
    const { source, target, precisionMode } = findPathState;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState =
      this.layer.displayState.segmentationGroupState.value;
    if (checkSegmentationOld(segmentationGroupState.timestamp, activation)) {
      return;
    }
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Find Path";
    body.classList.add("calcada-tool-status", "calcada-find-path");
    const submitAction = () => {
      findPathState.triggerPathUpdate.dispatch();
    };
    body.appendChild(
      makeIcon({
        text: "Submit",
        title: "Submit Find Path",
        onClick: () => {
          submitAction();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear Find Path",
        onClick: () => {
          findPathState.source.reset();
          findPathState.target.reset();
          findPathState.centroids.reset();
        },
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(precisionMode),
    );
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = "Precision mode: ";
    label.appendChild(labelText);
    label.title =
      "Precision mode returns a more accurate path, but takes longer.";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const annotationElements = document.createElement("div");
    annotationElements.classList.add("find-path-annotations");
    body.appendChild(annotationElements);
    const bindings = getDefaultAnnotationListBindings();
    this.registerDisposer(new MouseEventBinder(annotationElements, bindings));
    const updateAnnotationElements = () => {
      removeChildren(annotationElements);
      const maxColumnWidths = [0, 0, 0];
      const globalDimensionIndices = [0, 1, 2];
      const localDimensionIndices: number[] = [];
      const template =
        "[symbol] 2ch [dim] var(--neuroglancer-column-0-width) [dim] var(--neuroglancer-column-1-width) [dim] var(--neuroglancer-column-2-width) [delete] min-content";
      const endpoints = [source, target];
      const endpointAnnotations = endpoints
        .map((x) => x.value?.annotationReference?.value)
        .filter((x) => x) as Annotation[];
      for (const annotation of endpointAnnotations) {
        const [element, elementColumnWidths] = makeAnnotationListElement(
          this.layer,
          annotation,
          findPathAnnotationState,
          template,
          globalDimensionIndices,
          localDimensionIndices,
        );
        for (const [column, width] of elementColumnWidths.entries()) {
          maxColumnWidths[column] = width;
        }
        annotationElements.appendChild(element);
      }
      for (const [column, width] of maxColumnWidths.entries()) {
        annotationElements.style.setProperty(
          `--neuroglancer-column-${column}-width`,
          `${width + 2}ch`,
        );
      }
    };
    findPathState.changed.add(updateAnnotationElements);
    updateAnnotationElements();
    activation.bindInputEventMap(FIND_PATH_INPUT_EVENT_MAP);
    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
    activation.bindAction("add-point", (event) => {
      event.stopPropagation();
      (async () => {
        if (!source.value) {
          // first selection
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            source.value = selection;
          }
        } else if (!target.value) {
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            target.value = selection;
          }
        }
      })();
    });
  }

  toJSON() {
    return CALCADA_FIND_PATH_TOOL_ID;
  }

  get description() {
    return "find path";
  }
}

const PIECE_SPLIT_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+control+mousedown0": { action: "place-point" },
  "at:dblclick0": { action: "toggle-piece-mesh" },
  "at:shift?+keyg": { action: "swap-group" },
  "at:shift?+enter": { action: "apply" },
  "at:control+keyz": { action: "undo" },
});

// wrapCalcadaError turns an HttpError from a Calcada endpoint into a regular
// Error whose message is the server's `error` field (or `message`, or the raw
// body). Calcada's error envelope is `{"code":"X","error":"...","message":""}`,
// which `parseCalcadaError` mis-handles because it only reads `.message`.
async function wrapCalcadaError(e: unknown): Promise<Error> {
  if (!(e instanceof HttpError)) {
    return e instanceof Error ? e : new Error(String(e));
  }
  const resp = e.response;
  if (!resp) return e;
  try {
    if ((resp.headers.get("content-type") || "").includes("application/json")) {
      const j = await resp.json();
      const msg = j?.error || j?.message || JSON.stringify(j);
      return new Error(msg);
    }
    const text = await resp.text();
    return new Error(text || `HTTP ${resp.status}`);
  } catch {
    return new Error(`HTTP ${resp.status}`);
  }
}

// Convert a layer-space point (the form returned by getPoint) into integer
// voxel coordinates using the graph's resolution. Both arrays are expected
// to be in the conventional (x, y, z) order. The conversion truncates toward
// zero — matching the integer-division semantics the merge handler documents.
function layerPointToVoxel(
  layerPoint: Float32Array,
  annotationToNanometers: Float64Array,
  graphResolution: [number, number, number],
): VoxelPoint {
  return [
    Math.floor(
      (layerPoint[0] * annotationToNanometers[0]) / graphResolution[0],
    ),
    Math.floor(
      (layerPoint[1] * annotationToNanometers[1]) / graphResolution[1],
    ),
    Math.floor(
      (layerPoint[2] * annotationToNanometers[2]) / graphResolution[2],
    ),
  ];
}

class PieceSplitTool extends LayerTool<SegmentationUserLayer> {
  toJSON() {
    return CALCADA_PIECE_SPLIT_TOOL_ID;
  }

  get description() {
    return "piece split";
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) {
      return;
    }
    const segmentationGroupState =
      layer.displayState.segmentationGroupState.value;
    if (checkSegmentationOld(segmentationGroupState.timestamp, activation)) {
      return;
    }
    const {
      state: { pieceSplitState },
    } = graphConnection;

    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Piece split";
    body.classList.add("calcada-tool-status", "calcada-piece-split");

    // Dim the segmentation overlay (same mechanism as MulticutSegmentsTool) so
    // the bright point annotations stand out. The focus piece's root keeps
    // its outline visible via TRANSPARENT_COLOR_PACKED; every other segment
    // gets MULTICUT_OFF_COLOR. Save and restore the prior display state on
    // tool deactivation so the segmentation returns to its normal rendering.
    const { displayState } = layer;
    const priorHideSegmentZero = displayState.hideSegmentZero.value;
    const priorBaseSegmentHighlighting =
      displayState.baseSegmentHighlighting.value;
    const priorHighlightColor = displayState.highlightColor.value;
    // The tool renders the segment the way the rest of the app does: as one
    // segment. Breaking it into its pieces — hover highlighting a single piece in
    // 2D, and tinting each mesh fragment separately in 3D — is a debugging view,
    // so it is turned on only while Debug is active (see setPieceView).

    // Debug overlay state (toggled by the Debug button): the debugged root and a
    // per-piece colour map fetched from the backend. When on, every piece of the
    // root is tinted a distinct colour so a kept-whole segment's internal pieces
    // are individually visible; edge lines are drawn via the annotation states.
    // Result of a stepped split's first half, held until the second runs. Cleared
    // whenever the points change, since it names sub-pieces derived from them.
    let steppedSplit:
      | {
          sources: bigint[];
          sinks: bigint[];
          branchId: number;
          rootId?: bigint;
        }
      | undefined;

    let debugMode = false;
    let debugRootId: bigint | undefined;
    let debugPieceColors: Map<bigint, bigint> | undefined;

    // The focused segment is DERIVED from the placed points rather than stored:
    // it is the current root of the first point's piece. Storing it would let it
    // drift — any edit that re-roots the segment (a merge or split by anyone, or
    // an undo) leaves a saved id pointing at a superseded root, and the display
    // below would then show an empty segment. Deriving it means the focus follows
    // the segment automatically.
    //
    // Returns undefined when there are no points, or when the piece's
    // equivalences are not loaded yet (get() maps a piece to itself then, and a
    // piece id is never a root id) — callers must not hijack the display in that
    // case, or the segment would vanish while the mapping is still in flight.
    const currentFocusRoot = (): bigint | undefined => {
      const first =
        pieceSplitState.bluePoints.value[0] ??
        pieceSplitState.redPoints.value[0];
      if (first === undefined) return undefined;
      const root = segmentationGroupState.segmentEquivalences.get(
        first.pieceId,
      );
      return root === first.pieceId ? undefined : root;
    };

    // setPieceView switches between showing the selection as one segment (the
    // default, matching the rest of the app) and breaking it into its pieces.
    // baseSegmentHighlighting makes 2D hover pick out a single piece, and a
    // defined highlightColor is what gates per-fragment mesh colouring in
    // MeshLayer.draw — together they are the "piece view". Neither touches the
    // persisted baseSegmentColoring toggle, so leaving the tool restores whatever
    // the user had.
    const setPieceView = (on: boolean) => {
      displayState.baseSegmentHighlighting.value = on
        ? true
        : priorBaseSegmentHighlighting;
      displayState.highlightColor.value = on
        ? pieceSplitState.blueGroup.value
          ? BLUE_COLOR_HIGHTLIGHT
          : RED_COLOR_HIGHLIGHT
        : priorHighlightColor;
    };

    const resetPieceSplitDisplay = () => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.useTempSegmentStatedColors2d.value = false;
      displayState.tempSegmentStatedColors2d.value.clear();
      displayState.tempSegmentDefaultColor2d.value = undefined;
    };
    const updatePieceSplitDisplay = () => {
      resetPieceSplitDisplay();
      displayState.hideSegmentZero.value = false;
      // Keep the hover tint matching the active colour, but only while the piece
      // view is on — otherwise this would silently re-enable it.
      if (debugMode) {
        setPieceView(true);
      }

      // Debug overlay takes precedence: colour every piece of the debugged root
      // distinctly from the authoritative backend piece list.
      if (debugMode && debugRootId !== undefined && debugPieceColors) {
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        segmentationGroupState.useTemporarySegmentEquivalences.value = true;
        segmentationGroupState.temporaryVisibleSegments.add(debugRootId);
        for (const [piece, color] of debugPieceColors) {
          segmentationGroupState.temporaryVisibleSegments.add(piece);
          displayState.tempSegmentStatedColors2d.value.set(piece, color);
        }
        displayState.useTempSegmentStatedColors2d.value = true;
        return;
      }

      const focus = currentFocusRoot();
      if (focus === undefined) {
        displayState.useTempSegmentStatedColors2d.value = false;
        return;
      }
      // Colour each piece by the points placed on it — blue-only piece → blue,
      // red-only → red, a piece holding BOTH colours → left transparent so its
      // point markers show where it will be split. Mirrors the per-piece
      // recolouring MulticutSegmentsTool does, but driven by placed points and
      // allowing multiple points (both colours) inside one piece.
      const pieceColor = new Map<bigint, "blue" | "red" | "both">();
      const notePiece = (pieceId: bigint, color: "blue" | "red") => {
        const cur = pieceColor.get(pieceId);
        if (cur === undefined) pieceColor.set(pieceId, color);
        else if (cur !== color) pieceColor.set(pieceId, "both");
      };
      for (const p of pieceSplitState.bluePoints.value) {
        notePiece(p.pieceId, "blue");
      }
      for (const p of pieceSplitState.redPoints.value) {
        notePiece(p.pieceId, "red");
      }

      // Tint each constraint piece so it reads at a glance: blue-only → blue,
      // red-only → red, BOTH colours → green ("this piece will be cut"). Green
      // keeps the split target clearly highlighted instead of looking deselected.
      // Uncoloured pieces stay merged into the focus root at the segment's normal
      // colour, so the rest of the segment never looks deselected while you place
      // points. We do NOT dim the rest of the view (no MULTICUT_OFF_COLOR).
      // While a trace is reviewing this very segment, the trace owns what is
      // visible (seed + candidate only). Overriding it here would put the rest
      // of the view back and fight showOnly; the per-piece tinting below is
      // still applied, so the split preview is unaffected.
      const { zettaTraceState } = graphConnection.state;
      const traceOwnsFocus =
        zettaTraceState.active.value &&
        (focus === zettaTraceState.seedRoot.value ||
          focus === graphConnection.traceSession.current?.partnerRootId);
      if (!traceOwnsFocus) {
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        segmentationGroupState.temporaryVisibleSegments.add(focus);
      }
      segmentationGroupState.useTemporarySegmentEquivalences.value = true;
      let anyTint = false;
      for (const piece of segmentationGroupState.segmentEquivalences.setElements(
        focus,
      )) {
        if (!traceOwnsFocus) {
          segmentationGroupState.temporaryVisibleSegments.add(piece);
        }
        const color = pieceColor.get(piece);
        if (color === "blue") {
          displayState.tempSegmentStatedColors2d.value.set(
            piece,
            BLUE_COLOR_SEGMENT_PACKED,
          );
          anyTint = true;
        } else if (color === "red") {
          displayState.tempSegmentStatedColors2d.value.set(
            piece,
            RED_COLOR_SEGMENT_PACKED,
          );
          anyTint = true;
        } else if (color === "both") {
          displayState.tempSegmentStatedColors2d.value.set(
            piece,
            SPLIT_TARGET_COLOR_PACKED,
          );
          anyTint = true;
        } else {
          segmentationGroupState.temporarySegmentEquivalences.link(
            focus,
            piece,
          );
        }
      }
      displayState.useTempSegmentStatedColors2d.value = anyTint;
    };
    activation.registerDisposer(() => {
      resetPieceSplitDisplay();
      displayState.hideSegmentZero.value = priorHideSegmentZero;
      displayState.baseSegmentHighlighting.value = priorBaseSegmentHighlighting;
      displayState.highlightColor.value = priorHighlightColor;
      graphConnection.clearDebugEdges();
    });
    activation.registerDisposer(
      pieceSplitState.changed.add(updatePieceSplitDisplay),
    );
    updatePieceSplitDisplay();

    // --- Layout ---
    const focusRow = document.createElement("div");
    focusRow.className = "piece-split-focus";
    body.appendChild(focusRow);

    const groupRow = document.createElement("div");
    groupRow.className = "piece-split-group-row";
    body.appendChild(groupRow);

    const pointsContainer = document.createElement("div");
    pointsContainer.className = "piece-split-points";
    body.appendChild(pointsContainer);

    const actions = document.createElement("div");
    actions.className = "piece-split-actions";
    body.appendChild(actions);

    const swapButton = makeIcon({
      text: "Swap",
      title: "Toggle blue/red (G)",
      onClick: () => pieceSplitState.swapGroup(),
    });
    const clearButton = makeIcon({
      text: "Clear",
      title: "Remove all points, reset focus piece, and hide debug overlay",
      onClick: () => {
        clearDebug();
        pieceSplitState.reset();
      },
    });
    // The split in two halves, for inspecting the graph between them: the first
    // writes the sub-pieces and their edges but leaves the segment whole, the
    // second runs the ordinary multicut over what the first produced. Enter
    // triggers whichever step is next.
    const splitPiecesButton = makeIcon({
      text: "1. Pieces",
      title:
        "Step 1: split the pieces and add their edges, keeping one segment (inspect with Debug). Enter runs this while step 2 is not available.",
      onClick: () => void runSplitPieces(),
    });
    const cutButton = makeIcon({
      text: "2. Cut",
      title:
        "Step 2: run the regular multicut over the pieces from step 1. Enter runs this once step 1 is done.",
      onClick: () => void runCut(),
    });
    const undoButton = makeIcon({
      text: "Undo",
      title: "Undo the last edit (Ctrl+Z)",
      onClick: () => void runUndo(),
    });
    const DEBUG_OFF_TITLE =
      "Show debug overlay: colour each piece distinctly and draw a line per edge (green = zero-affinity split edges)";
    const debugButton = makeIcon({
      text: "Debug",
      title: DEBUG_OFF_TITLE,
      onClick: () => void runDebug(),
    });
    // Reflect the toggle state on the button itself: without this the overlay
    // looks impossible to remove because nothing signals it is currently on.
    const setDebugButtonActive = (active: boolean) => {
      debugButton.textContent = active ? "Hide Debug" : "Debug";
      debugButton.title = active
        ? "Debug overlay is ON — click to hide it"
        : DEBUG_OFF_TITLE;
      debugButton.style.backgroundColor = active ? "rgba(0, 200, 0, 0.35)" : "";
      debugButton.style.outline = active ? "1px solid rgba(0,255,0,0.85)" : "";
    };
    actions.appendChild(swapButton);
    actions.appendChild(clearButton);
    actions.appendChild(splitPiecesButton);
    actions.appendChild(cutButton);
    actions.appendChild(undoButton);
    actions.appendChild(debugButton);
    const spinner = document.createElement("div");
    spinner.className = "piece-split-spinner";
    spinner.style.display = "none";
    actions.appendChild(spinner);

    const useImageCheckbox = document.createElement("input");
    useImageCheckbox.type = "checkbox";
    useImageCheckbox.checked = pieceSplitState.useImage.value;
    useImageCheckbox.addEventListener("change", () => {
      pieceSplitState.useImage.value = useImageCheckbox.checked;
    });
    const useImageLabel = document.createElement("label");
    useImageLabel.className = "piece-split-use-image";
    useImageLabel.title =
      "Price the cut from the EM image (dark membranes are cheap to cut). " +
      "Slower — reads the image volume. Off: the cut uses geometry only.";
    useImageLabel.appendChild(useImageCheckbox);
    useImageLabel.appendChild(document.createTextNode("Use image for cut"));
    body.appendChild(useImageLabel);

    let busy = false;
    const setStepButtonsEnabled = (enabled: boolean) => {
      splitPiecesButton.classList.toggle("disabled", busy || !enabled);
      // Step 2 only means anything once step 1 has produced pieces to cut.
      cutButton.classList.toggle(
        "disabled",
        busy || steppedSplit === undefined,
      );
    };
    const setUndoEnabled = () => {
      // Disabled until there is at least one edit to revert (point 3).
      undoButton.classList.toggle(
        "disabled",
        busy || !graphConnection.canUndo(),
      );
    };
    const setBusy = (nextBusy: boolean) => {
      busy = nextBusy;
      spinner.style.display = busy ? "" : "none";
      useImageCheckbox.disabled = busy;
      for (const button of [
        swapButton,
        clearButton,
        splitPiecesButton,
        cutButton,
        undoButton,
        debugButton,
      ]) {
        button.classList.toggle("disabled", busy);
      }
      if (!busy) render();
    };

    const render = () => {
      // Focus piece label.
      const focus = currentFocusRoot();
      focusRow.textContent =
        focus !== undefined
          ? `Focus piece: ${focus.toString()}`
          : "Ctrl+click on a selected segment to place the first point.";

      // Active-colour indicator.
      removeChildren(groupRow);
      const indicator = document.createElement("span");
      indicator.textContent = pieceSplitState.blueGroup.value
        ? "Active: BLUE (will place blue point on click)"
        : "Active: RED (will place red point on click)";
      groupRow.appendChild(indicator);

      // Point lists.
      removeChildren(pointsContainer);
      const renderList = (
        label: string,
        cssClass: string,
        points: PointEntry[],
        group: "blue" | "red",
      ) => {
        const section = document.createElement("div");
        section.className = cssClass;
        const title = document.createElement("div");
        title.textContent = `${label} (${points.length})`;
        section.appendChild(title);
        for (let i = 0; i < points.length; i++) {
          const row = document.createElement("div");
          row.className = "piece-split-point-row";
          const text = document.createElement("span");
          const [x, y, z] = points[i].voxel;
          text.textContent = `  (${x}, ${y}, ${z})`;
          row.appendChild(text);
          const del = makeDeleteButton({
            title: "Remove point",
            onClick: () => pieceSplitState.removePoint(group, i),
          });
          row.appendChild(del);
          section.appendChild(row);
        }
        pointsContainer.appendChild(section);
      };
      renderList(
        "Blue points",
        "piece-split-blue",
        pieceSplitState.bluePoints.value,
        "blue",
      );
      renderList(
        "Red points",
        "piece-split-red",
        pieceSplitState.redPoints.value,
        "red",
      );

      useImageCheckbox.checked = pieceSplitState.useImage.value;
      // Step 1 is enabled once both colours have at least one point.
      setStepButtonsEnabled(
        pieceSplitState.bluePoints.value.length > 0 &&
          pieceSplitState.redPoints.value.length > 0,
      );
      setUndoEnabled();
    };
    render();
    activation.registerDisposer(pieceSplitState.changed.add(render));

    // --- Actions ---
    const runUndo = async () => {
      // An undo may take step 1's sub-pieces back out of the graph, so the
      // pending cut no longer refers to anything.
      steppedSplit = undefined;
      if (busy) return;
      if (!graphConnection.canUndo()) {
        StatusMessage.showTemporaryMessage("Nothing to undo", 2500);
        return;
      }
      setBusy(true);
      try {
        await graphConnection.undo();
        clearDebug(); // the overlay's piece ids are now stale
      } finally {
        setBusy(false);
      }
    };

    // Pick the root to debug: the root step 1 produced if a stepped split is in
    // flight, else the focus piece, else the single visible segment.
    //
    // Step 1 is checked first because it supersedes the pieces the points were
    // placed on. currentFocusRoot() maps the first point's piece id through the
    // equivalences, which keep resolving it to the pre-split root until the
    // re-fetched chunks repopulate them — debugging that root returns an empty
    // graph and reads as the split having wiped the segment's edges.
    const debugTargetRoot = (): bigint | undefined => {
      if (steppedSplit?.rootId !== undefined) return steppedSplit.rootId;
      const focusRoot = currentFocusRoot();
      if (focusRoot !== undefined) return focusRoot;
      let only: bigint | undefined;
      for (const segment of segmentationGroupState.visibleSegments) {
        if (segment === 0n) continue;
        if (only !== undefined) return undefined; // ambiguous
        only = segment;
      }
      return only;
    };

    // Selects `id` in whichever layer panel hosts it. With `onlyIfCurrent`
    // set, switches only when that tab is the one currently selected (used to
    // leave the debug tab when debug mode ends without hijacking the panel
    // otherwise).
    const selectLayerPanelTab = (id: string, onlyIfCurrent?: string) => {
      for (const panel of layer.panels.panels) {
        if (!panel.tabs.includes(id)) continue;
        if (
          onlyIfCurrent !== undefined &&
          panel.selectedTab.value !== onlyIfCurrent
        ) {
          return;
        }
        panel.selectedTab.value = id;
        return;
      }
    };

    const clearDebug = () => {
      if (!debugMode) return;
      debugMode = false;
      setPieceView(false);
      debugRootId = undefined;
      debugPieceColors = undefined;
      graphConnection.setDebugPieces(undefined, undefined);
      selectLayerPanelTab("segments", "calcada-debug");
      graphConnection.clearDebugEdges();
      setDebugButtonActive(false);
      updatePieceSplitDisplay();
    };

    const runDebug = async () => {
      if (busy) return;
      if (debugMode) {
        clearDebug();
        return;
      }
      const root = debugTargetRoot();
      if (root === undefined) {
        StatusMessage.showTemporaryMessage(
          "Select a single segment (or place a point) to debug",
          5000,
        );
        return;
      }
      setBusy(true);
      try {
        const { pieces, edges } =
          await graphConnection.graph.graphServer.debugGraph(
            root,
            layer.displayState.segmentationGroupState.value.timestamp.value ??
              0,
            graphConnection.graph.branchId.value,
          );
        debugRootId = root;
        debugPieceColors = new Map<bigint, bigint>();
        const centerById = new Map<bigint, [number, number, number]>();
        let owned = 0;
        for (const piece of pieces) {
          centerById.set(piece.id, piece.center);
          if (piece.external) continue;
          debugPieceColors!.set(
            piece.id,
            DEBUG_PIECE_PALETTE[owned % DEBUG_PIECE_PALETTE.length],
          );
          owned++;
        }
        const edgeLines: Line[] = [];
        const siblingLines: Line[] = [];
        let undrawable = 0;
        let siblingEdgeCount = 0;
        const lineBetween = (from: vec3, to: vec3): Line => ({
          pointA: from,
          pointB: to,
          id: "",
          type: AnnotationType.LINE,
          properties: [],
        });
        for (const edge of edges) {
          const centerA = centerById.get(edge.a);
          const centerB = centerById.get(edge.b);
          if (!centerA || !centerB) {
            undrawable++;
            continue;
          }
          const pointA = vec3.fromValues(centerA[0], centerA[1], centerA[2]);
          const pointB = vec3.fromValues(centerB[0], centerB[1], centerB[2]);
          // Bend the line through the edge's stored contact position when the
          // server provides one, so it marks where the pieces actually touch —
          // bbox centres alone can put the whole line inside one mesh.
          const hasContactPos = edge.pos.some((coordinate) => coordinate !== 0);
          const segments: Line[] = [];
          if (hasContactPos) {
            const contactPos = vec3.fromValues(
              edge.pos[0],
              edge.pos[1],
              edge.pos[2],
            );
            segments.push(
              lineBetween(pointA, contactPos),
              lineBetween(contactPos, pointB),
            );
          } else {
            segments.push(lineBetween(pointA, pointB));
          }
          if (edge.affinity === 0 && edge.status === "enabled") {
            siblingEdgeCount++;
            siblingLines.push(...segments);
          } else {
            edgeLines.push(...segments);
          }
        }
        graphConnection.setDebugEdges(edgeLines, siblingLines);
        debugMode = true;
        graphConnection.setDebugPieces(debugRootId, debugPieceColors);
        selectLayerPanelTab("calcada-debug");
        setDebugButtonActive(true);
        setPieceView(true);
        updatePieceSplitDisplay();
        StatusMessage.showTemporaryMessage(
          `Debug: ${pieces.length} pieces, ${edges.length} edges ` +
            `(${siblingEdgeCount} green zero-affinity split edge(s)` +
            (undrawable > 0 ? `, ${undrawable} not drawable` : "") +
            `). Press Debug again to hide.`,
          6000,
        );
      } catch (e: unknown) {
        StatusMessage.showTemporaryMessage(
          `Debug failed: ${e instanceof Error ? e.message : String(e)}`,
          8000,
        );
      } finally {
        setBusy(false);
      }
    };

    // Step 1: cut every multi-colour piece and write the edges its halves inherit,
    // but leave everything in one segment. What the multicut will act on is then
    // in the graph and can be looked at with Debug before anything is separated.
    const runSplitPieces = async () => {
      if (
        pieceSplitState.bluePoints.value.length === 0 ||
        pieceSplitState.redPoints.value.length === 0
      ) {
        StatusMessage.showTemporaryMessage(
          "Place at least one blue and one red point",
          5000,
        );
        return;
      }
      setBusy(true);
      const branchId = graphConnection.graph.branchId.value;
      try {
        const toPayload = (p: PointEntry, color: "blue" | "red") => ({
          color,
          pieceId: p.pieceId,
          x: p.voxel[0],
          y: p.voxel[1],
          z: p.voxel[2],
          origin: p.origin,
        });
        const points = [
          ...pieceSplitState.bluePoints.value.map((p) => toPayload(p, "blue")),
          ...pieceSplitState.redPoints.value.map((p) => toPayload(p, "red")),
        ];
        const { roots, components, operationId, splitPieces } =
          await graphConnection.graph.graphServer.generalSplit(
            points,
            branchId,
            true,
            pieceSplitState.useImage.value,
          );
        graphConnection.pushUndo(operationId, branchId);

        // Name the two sides for step 2. A piece that was split contributes its
        // blue half to the sources and its red half to the sinks; a piece holding
        // only one colour is untouched and stands for itself.
        const wasSplit = new Set(splitPieces.map((sp) => sp.old));
        const sources = new Set<bigint>();
        const sinks = new Set<bigint>();
        for (const sp of splitPieces) {
          sources.add(sp.blue);
          sinks.add(sp.red);
        }
        for (const p of pieceSplitState.bluePoints.value) {
          if (!wasSplit.has(p.pieceId)) sources.add(p.pieceId);
        }
        for (const p of pieceSplitState.redPoints.value) {
          if (!wasSplit.has(p.pieceId)) sinks.add(p.pieceId);
        }
        // The segment stays whole but its pieces changed, so the piece->root
        // mapping is stale.
        const newRoots = roots.filter((root) => root !== 0n);

        steppedSplit = {
          sources: [...sources],
          sinks: [...sinks],
          branchId,
          // Step 1 keeps the segment whole, so it reports exactly one root; hold
          // it so Debug inspects the post-split graph rather than resolving the
          // now-superseded pieces the points still name.
          rootId: newRoots.length === 1 ? newRoots[0] : undefined,
        };

        const focus = currentFocusRoot();
        if (newRoots.length > 0 && focus !== undefined) {
          // Split-mode 2D renders raw piece ids through segmentEquivalences, so
          // the links must follow the edit. With pieces_only the segment stays
          // whole, so the response carries one component holding the new root's
          // complete piece list — authoritative where the local reconstruction
          // was only as fresh as the last chunk fetch.
          graphConnection.updateAfterSplit(focus, newRoots, components);
          graphConnection.meshAddNewSegments(newRoots);
          const oldRootSet = new Uint64Set();
          oldRootSet.add(focus);
          const newRootSet = new Uint64Set();
          newRootSet.add(newRoots);
          graphConnection.notifyGraphEdited(oldRootSet, newRootSet);
        }
        clearDebug();
        StatusMessage.showTemporaryMessage(
          `Step 1 done — ${splitPieces.length} piece(s) split, segment still whole. ` +
            `Press Debug to inspect the edges, then "2. Cut".`,
          8000,
        );
        render();
      } catch (e: unknown) {
        StatusMessage.showTemporaryMessage(
          `Step 1 failed: ${e instanceof Error ? e.message : String(e)}`,
          8000,
        );
      } finally {
        setBusy(false);
      }
    };

    // Step 2: the ordinary multicut, over the pieces step 1 left behind.
    const runCut = async () => {
      if (steppedSplit === undefined) {
        StatusMessage.showTemporaryMessage('Run "1. Pieces" first', 5000);
        return;
      }
      setBusy(true);
      const { sources, sinks, branchId, rootId } = steppedSplit;
      try {
        const { roots, components, operationId } =
          await graphConnection.graph.graphServer.splitByPieces(
            sources,
            sinks,
            branchId,
          );
        const newRoots = roots.filter((root) => root !== 0n);
        if (newRoots.length === 0) {
          StatusMessage.showTemporaryMessage("No split found.", 3000);
          return;
        }
        graphConnection.pushUndo(operationId, branchId);
        const segmentsState = layer.displayState.segmentationGroupState.value;
        for (const piece of [...sources, ...sinks]) {
          segmentsState.selectedSegments.delete(piece);
          segmentsState.visibleSegments.delete(piece);
        }
        // The post-pieces root is superseded by the two cut roots. rootId is
        // the authoritative handle (currentFocusRoot maps the first point's
        // piece, which the pieces step already retired).
        const oldRoot = rootId ?? currentFocusRoot();
        if (oldRoot !== undefined) {
          // Reconcile from the server's authoritative components instead of
          // re-fetching chunks and waiting out the lagging LUT.
          graphConnection.updateAfterSplit(oldRoot, newRoots, components);
          graphConnection.meshAddNewSegments(newRoots);
          const oldRootSet = new Uint64Set();
          oldRootSet.add(oldRoot);
          const newRootSet = new Uint64Set();
          newRootSet.add(newRoots);
          graphConnection.notifyGraphEdited(oldRootSet, newRootSet);
        } else {
          for (const newRoot of newRoots) {
            segmentsState.selectedSegments.add(newRoot);
            segmentsState.visibleSegments.add(newRoot);
          }
          graphConnection.meshAddNewSegments(newRoots);
        }
        clearDebug();
        steppedSplit = undefined;
        pieceSplitState.reset();
        StatusMessage.showTemporaryMessage(
          `Step 2 done — separated into ${newRoots.length} root(s). Press Ctrl+Z to undo.`,
          6000,
        );
      } catch (e: unknown) {
        StatusMessage.showTemporaryMessage(
          `Step 2 failed: ${e instanceof Error ? e.message : String(e)}`,
          8000,
        );
      } finally {
        setBusy(false);
      }
    };

    // --- Click placement ---
    activation.bindInputEventMap(PIECE_SPLIT_INPUT_EVENT_MAP);
    const placePoint = async () => {
      const { mouseState } = this;
      const point = getPoint(layer, mouseState);
      if (point === undefined) return;
      // baseValue is the piece (super-voxel) at the clicked voxel; value is its
      // aggregated root. We split pieces, so always work with baseValue.
      const { value, baseValue } = layer.displayState.segmentSelectionState;
      if (baseValue === undefined || baseValue === null || baseValue === 0n) {
        StatusMessage.showTemporaryMessage(
          "No piece is selected at the click position",
          3000,
        );
        return;
      }
      if (!value || !segmentationGroupState.visibleSegments.has(value)) {
        StatusMessage.showTemporaryMessage(
          "Points can only be placed on selected segments",
          5000,
        );
        return;
      }
      // The first point establishes the focus segment implicitly (the focus is
      // derived from it); later points may land in any piece of that segment, in
      // the same piece or across pieces.
      const currentFocus = currentFocusRoot();
      if (currentFocus !== undefined && value !== currentFocus) {
        StatusMessage.showTemporaryMessage(
          `Point must be inside segment ${currentFocus.toString()} (clicked segment: ${value.toString()}). Remove all points to change focus.`,
          6000,
        );
        return;
      }
      const loadedSubsource = getGraphLoadedSubsource(layer)!;
      const annotationToNanometers =
        loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
          (x: number) => x / 1e-9,
        );
      const graphResolution = graphConnection.graph.info.scales[0]
        .resolution as unknown as [number, number, number];
      const voxel = layerPointToVoxel(
        point,
        new Float64Array(annotationToNanometers),
        graphResolution,
      );
      const origin: "2d" | "3d" =
        mouseState.pickedRenderLayer instanceof PerspectiveViewRenderLayer
          ? "3d"
          : "2d";
      pieceSplitState.addPoint({
        voxel,
        layer: [point[0], point[1], point[2]],
        pieceId: baseValue,
        origin,
      });
    };
    activation.bindAction("toggle-piece-mesh", (event) => {
      event.stopPropagation();
      const { baseValue } = layer.displayState.segmentSelectionState;
      if (
        debugMode &&
        baseValue !== undefined &&
        baseValue !== null &&
        baseValue !== 0n
      ) {
        graphConnection.togglePieceMesh(baseValue);
        return;
      }
      // Outside debug mode keep the stock double-click behaviour: toggle the
      // hovered segment's visibility.
      const sss = layer.displayState.segmentSelectionState;
      if (sss.hasSelectedSegment) {
        const seg = sss.selectedSegment;
        const group = segmentationGroupState;
        if (group.visibleSegments.has(seg)) {
          group.visibleSegments.delete(seg);
        } else {
          group.visibleSegments.add(seg);
        }
      }
    });
    activation.bindAction("place-point", (event) => {
      event.stopPropagation();
      void placePoint();
    });
    activation.bindAction("swap-group", (event) => {
      event.stopPropagation();
      pieceSplitState.swapGroup();
    });
    // Enter runs whichever step is next: the multicut once step 1 has produced
    // pieces to cut, the piece split otherwise.
    activation.bindAction("apply", (event) => {
      event.stopPropagation();
      if (steppedSplit !== undefined) {
        void runCut();
      } else {
        void runSplitPieces();
      }
    });
    activation.bindAction("undo", (event) => {
      event.stopPropagation();
      void runUndo();
    });
  }
}

registerTool(SegmentationUserLayer, CALCADA_PIECE_SPLIT_TOOL_ID, (layer) => {
  return new PieceSplitTool(layer, true);
});

registerTool(
  SegmentationUserLayer,
  CALCADA_MULTICUT_SEGMENTS_TOOL_ID,
  (layer) => {
    return new MulticutSegmentsTool(layer, true);
  },
);

registerTool(SegmentationUserLayer, CALCADA_MERGE_SEGMENTS_TOOL_ID, (layer) => {
  return new MergeSegmentsTool(layer, true);
});

registerTool(SegmentationUserLayer, CALCADA_FIND_PATH_TOOL_ID, (layer) => {
  return new FindPathTool(layer, true);
});

// Stage 0 serves a single ingested contact wave. The value must match the batch
// the ingest job was run with — it identifies the experiment as well as the
// wave, since two experiments both have a wave_2. When several coexist this has
// to come from the datasource parameters instead of a constant.
const DEFAULT_CANDIDATE_BATCH = "exp3_taper2_w2";
const CANDIDATE_FETCH_LIMIT = 50;

/**
 * Turns Zetta Trace on and off.
 *
 * The tool holds no trace state — that lives in ZettaTraceSession, so the mode
 * outlives this activation and the proofreader can pick up merge or cut without
 * losing the seed and the candidate under review. Activating deliberately does
 * not deactivate: this is a toggle whose "off" is Esc or pressing the button
 * again.
 */
class ZettaTraceTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const {
      graphConnection: { value: graphConnection },
    } = this.layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) {
      activation.cancel();
      return;
    }
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    if (checkSegmentationOld(segmentsState.timestamp, activation)) {
      return;
    }
    const { zettaTraceState } = graphConnection.state;
    zettaTraceState.active.value = !zettaTraceState.active.value;
    // The mode owns its own keys and panel from here, so the activation has
    // nothing left to hold: releasing it lets the next tool take the slot
    // without ending the trace.
    activation.cancel();
  }

  get description() {
    return "zetta trace";
  }

  toJSON() {
    return CALCADA_ZETTA_TRACE_TOOL_ID;
  }
}

registerTool(SegmentationUserLayer, CALCADA_ZETTA_TRACE_TOOL_ID, (layer) => {
  return new ZettaTraceTool(layer, true);
});

const ANNOTATE_MERGE_LINE_TOOL_ID = "annotateMergeLine";

registerLegacyTool(
  ANNOTATE_MERGE_LINE_TOOL_ID,
  (layer, options) =>
    new MergeSegmentsPlaceLineTool(<SegmentationUserLayer>layer, options),
);

// Bulk link handler — receives all piece→root pairs from the worker in one
// transferable buffer. ONE postMessage instead of 52K individual link() RPCs.
// changed.dispatch is coalesced across all chunks that arrive in the same
// animation frame: re-uploading the equivalences hash map to the GPU is the
// expensive part (10-50ms per dispatch), so firing it once a frame instead of
// once per chunk turns 10 paralellel chunk arrivals from ~500ms of
// main-thread jank into ~50ms.
const pendingDispatch = new Set<SharedDisjointUint64Sets>();
let dispatchScheduled = false;

registerRPC(CALCADA_BULK_LINK_RPC_ID, function (x) {
  const obj = this.get(x.id) as SharedDisjointUint64Sets;
  const buf = new BigUint64Array(x.pairs);
  let linked = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (obj.disjointSets.link(buf[i], buf[i + 1])) {
      linked++;
    }
  }
  if (linked === 0) return;
  pendingDispatch.add(obj);
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  requestAnimationFrame(() => {
    dispatchScheduled = false;
    const targets = Array.from(pendingDispatch);
    pendingDispatch.clear();
    for (const target of targets) {
      target.changed.dispatch();
    }
  });
});

// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
//
// Baseline decode worker (TM-373): decodes compressed-segmentation chunks into
// the dense baseline the edit library reads, off the main thread.
import "#src/util/polyfills.js";
import "#src/editing/adapters/baseline_decode_worker_handler.js";

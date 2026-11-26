"""The real web API routes the edit session calls, for its e2e (TM-331).

Mounts `web_api/app/painting.py` at `/painting` and `web_api/app/segmentation.py`
at `/segmentation` from a zetta_utils checkout, exactly as `web_api/app/main.py`
does, and adds `/healthz` for the launcher. Nothing here re-implements a route:
`POST /painting/cutout` (the save write), `GET /painting/cutout` (the test's
storage oracle) and `POST /segmentation/propagate_mask` (z-extrapolation) are
the production handlers, request parsing and response encoding included.
`webapi_server.mjs` runs this with `STORAGE_EMULATOR_HOST` pointed at the
fixtures' fake-gcs, so `gs://` reads and writes land there.

Only the propagation MODEL is replaced. Cutie and SAM 2.1 need a GPU and
weights from GCS, and what they predict cannot be written down in advance. The
stand-in shifts the mask by `PROPAGATION_SHIFT_X` voxels along x, so the voxels
a run must paint are known exactly, and records what each request carried so a
test can check what the client sent (`GET /e2e/propagation-requests`).
"""

import hashlib
import threading

import numpy as np
from app import segmentation
from app.painting import api as painting_api
from fastapi import FastAPI

PROPAGATION_SHIFT_X = 3

_propagation_requests: list[dict] = []
_propagation_requests_lock = threading.Lock()


def _shift_along_x(
    current_image_np: np.ndarray,
    mask_np: np.ndarray,
    image_np: np.ndarray,
    cancel_event: threading.Event,
) -> np.ndarray:
    """The model stand-in: the mask moved `PROPAGATION_SHIFT_X` voxels to +x."""
    del cancel_event
    with _propagation_requests_lock:
        _propagation_requests.append(
            {
                "shape": list(mask_np.shape),
                "mask_dtype": str(mask_np.dtype),
                "mask_labels": sorted(int(label) for label in np.unique(mask_np)),
                "mask_voxels": int(np.count_nonzero(mask_np)),
                "current_image_sha256": hashlib.sha256(current_image_np.tobytes()).hexdigest(),
                "next_image_sha256": hashlib.sha256(image_np.tobytes()).hexdigest(),
            }
        )
    predicted = np.zeros(mask_np.shape, dtype=np.uint8)
    predicted[:, PROPAGATION_SHIFT_X:] = mask_np[:, :-PROPAGATION_SHIFT_X]
    return predicted


segmentation._run_propagation = _shift_along_x  # pylint: disable=protected-access

app = FastAPI()
app.mount("/painting", painting_api)
app.mount("/segmentation", segmentation.api)


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/e2e/propagation-requests")
def propagation_requests() -> list[dict]:
    with _propagation_requests_lock:
        return list(_propagation_requests)

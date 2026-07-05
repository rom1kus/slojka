"""SAM 2.1: интерактивная сегментация.

Модель грузится лениво по /sam/load. torch/sam2 могут быть не установлены —
тогда status() = 'absent' и endpoints отвечают 409. Эмбеддинг изображения
кэшируется по хэшу: повторные клики по той же картинке почти мгновенны.
"""

import asyncio
import base64
import hashlib
import io
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..paths import data_dir as _data_dir


CHECKPOINT_URLS = {
    "tiny": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
    "small": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
    "base_plus": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
    "large": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
}


def checkpoint_path(size: str) -> Path:
    return _data_dir() / "models" / f"sam2.1_hiera_{size}.pt"


class SetImageRequest(BaseModel):
    png_base64: str


class PredictPoint(BaseModel):
    x: float
    y: float
    label: int  # 1 = позитивная, 0 = негативная


class PredictRequest(BaseModel):
    points: list[PredictPoint] = []
    box: Optional[list[float]] = None  # [x0, y0, x1, y1]


class LoadRequest(BaseModel):
    model_size: str  # tiny | small | base_plus | large


class DownloadRequest(BaseModel):
    model_size: str


MODEL_CFGS = {
    "tiny": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "small": "configs/sam2.1/sam2.1_hiera_s.yaml",
    "base_plus": "configs/sam2.1/sam2.1_hiera_b+.yaml",
    "large": "configs/sam2.1/sam2.1_hiera_l.yaml",
}


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        import sam2  # noqa: F401

        return True
    except ImportError:
        return False


class SamService:
    def __init__(self) -> None:
        self.router = APIRouter()
        self._predictor: Any = None
        self._model_size: Optional[str] = None
        self._device: Optional[str] = None
        self._image_hash: Optional[str] = None
        self._image_size: tuple[int, int] = (0, 0)
        # Прогресс скачивания чекпойнтов: size → {status, received, total, error}.
        self._downloads: dict[str, dict] = {}
        self._register()

    def status(self) -> dict:
        return {
            "installed": _torch_available(),
            "loaded": self._predictor is not None,
            "model_size": self._model_size,
            "device": self._device,
        }

    def _register(self) -> None:
        router = self.router

        @router.get("/status")
        async def status() -> dict:
            return self.status()

        @router.post("/download")
        async def download(req: DownloadRequest) -> dict:
            """Скачивание чекпойнта в фоне (httpx уважает системные прокси)."""
            if req.model_size not in CHECKPOINT_URLS:
                raise HTTPException(400, f"неизвестный размер модели: {req.model_size}")
            dest = checkpoint_path(req.model_size)
            if dest.exists():
                self._downloads[req.model_size] = {"status": "done", "received": 0, "total": 0}
                return {"ok": True, "already": True}
            state = self._downloads.get(req.model_size)
            if state and state["status"] == "downloading":
                return {"ok": True, "already": False}
            self._downloads[req.model_size] = {
                "status": "downloading",
                "received": 0,
                "total": 0,
            }
            asyncio.get_event_loop().create_task(
                self._download(req.model_size, CHECKPOINT_URLS[req.model_size], dest)
            )
            return {"ok": True, "already": False}

        @router.get("/download-status/{size}")
        async def download_status(size: str) -> dict:
            return self._downloads.get(size, {"status": "none"})

        @router.post("/load")
        async def load(req: LoadRequest) -> dict:
            if not _torch_available():
                raise HTTPException(409, "torch/sam2 не установлены")
            if req.model_size not in MODEL_CFGS:
                raise HTTPException(400, f"неизвестный размер модели: {req.model_size}")
            ckpt = checkpoint_path(req.model_size)
            if not ckpt.exists():
                raise HTTPException(409, "чекпойнт не скачан (POST /sam/download)")

            import torch
            from sam2.build_sam import build_sam2
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            device = "cuda" if torch.cuda.is_available() else "cpu"
            model = build_sam2(MODEL_CFGS[req.model_size], str(ckpt), device=device)
            self._predictor = SAM2ImagePredictor(model)
            self._model_size = req.model_size
            self._device = device
            self._image_hash = None
            return {"ok": True, "device": device}

        @router.post("/set-image")
        async def set_image(req: SetImageRequest) -> dict:
            predictor = self._require_predictor()
            raw = base64.b64decode(req.png_base64)
            digest = hashlib.sha256(raw).hexdigest()
            if digest == self._image_hash:
                return {"ok": True, "cached": True}

            import numpy as np
            from PIL import Image

            img = Image.open(io.BytesIO(raw)).convert("RGB")
            predictor.set_image(np.array(img))
            self._image_hash = digest
            self._image_size = img.size
            return {"ok": True, "cached": False}

        @router.post("/predict")
        async def predict(req: PredictRequest) -> dict:
            predictor = self._require_predictor()
            if self._image_hash is None:
                raise HTTPException(409, "сначала /sam/set-image")
            if not req.points and not req.box:
                raise HTTPException(400, "нужны точки или box")

            import numpy as np

            coords = (
                np.array([[p.x, p.y] for p in req.points], dtype=np.float32)
                if req.points
                else None
            )
            labels = (
                np.array([p.label for p in req.points], dtype=np.int32)
                if req.points
                else None
            )
            box = np.array(req.box, dtype=np.float32) if req.box else None

            masks, scores, _ = predictor.predict(
                point_coords=coords,
                point_labels=labels,
                box=box,
                multimask_output=True,
            )

            order = np.argsort(scores)[::-1]
            out = []
            for idx in order[:3]:
                out.append(
                    {
                        "score": float(scores[idx]),
                        "png_base64": _mask_to_png_base64(masks[idx]),
                    }
                )
            return {"masks": out}

    async def _download(self, size: str, url: str, dest: Path) -> None:
        state = self._downloads[size]
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            part = dest.with_suffix(".part")
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", url, follow_redirects=True) as resp:
                    resp.raise_for_status()
                    state["total"] = int(resp.headers.get("content-length", 0))
                    with part.open("wb") as f:
                        async for chunk in resp.aiter_bytes(1 << 20):
                            f.write(chunk)
                            state["received"] += len(chunk)
            part.rename(dest)
            state["status"] = "done"
        except Exception as e:  # noqa: BLE001
            state["status"] = "error"
            state["error"] = str(e)

    def _require_predictor(self) -> Any:
        if self._predictor is None:
            raise HTTPException(409, "модель SAM не загружена (POST /sam/load)")
        return self._predictor


def _mask_to_png_base64(mask: Any) -> str:
    """Бинарная маска (H, W) → серый PNG (255 внутри объекта)."""
    import numpy as np
    from PIL import Image

    arr = (np.asarray(mask) > 0.5).astype("uint8") * 255
    img = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")

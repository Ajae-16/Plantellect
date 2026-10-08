from fastapi import FastAPI, File, UploadFile, Form, Header, HTTPException
from pydantic import BaseModel
from pathlib import Path
from typing import Dict, List, Optional
import datetime
import os
import json
import time
from predict import (
    load_model, predict_image, get_model_info,
    check_model_output, input_shape_of,
)
from preprocess import preprocess_image, load_config, check_model_input

app = FastAPI(
    title="Plantellect ML Inference Service",
    description="TensorFlow/Keras plant identification model inference API",
    version="1.0.0"
)

# Layout: one folder per model, each holding the same three files.
#   /app/model/efficientnetv2b1/{plantellect_model.keras, classes.json, preprocessing.json}
#   /app/model/convnexttiny/{plantellect_model.keras, classes.json, preprocessing.json}
# The folder name is the model_id, and the key of that model's entry in
# system_settings['mlConfidence'].
MODEL_ROOT = Path(os.getenv("MODEL_ROOT", "/app/model"))
MODEL_FILE = "plantellect_model.keras"

# Used when a request carries no (or no usable) x-model-id header. Express decides
# the ACTIVE model at runtime and sends it per request; this is only the floor.
DEFAULT_MODEL_ID = os.getenv("DEFAULT_MODEL_ID", "efficientnetv2b1")

registry: Dict[str, dict] = {}      # model_id -> {model, classes, cfg, version}
load_errors: Dict[str, str] = {}    # model_id -> why it was skipped


def derive_model_version(model_id: str, model_path: Path, cfg) -> str:
    """<architecture>-<model file date (UTC)>, so a retrained model gets a new version."""
    stamp = datetime.datetime.fromtimestamp(
        model_path.stat().st_mtime, datetime.timezone.utc).strftime("%Y%m%d")
    return f"{cfg.model or model_id}-{stamp}"


def load_entry(model_dir: Path) -> dict:
    """Load one model folder and run every consistency check. Raises on any problem."""
    model_path = model_dir / MODEL_FILE
    cfg = load_config(str(model_dir))
    model = load_model(str(model_path))
    with open(model_dir / "classes.json", "r") as f:
        classes = json.load(f)
    check_model_input(cfg, input_shape_of(model))   # wrong preprocessing.json for this model?
    check_model_output(model, classes)              # softmax probabilities, right class count?
    return {
        "model": model,
        "classes": classes,
        "cfg": cfg,
        "version": derive_model_version(model_dir.name, model_path, cfg),
    }


@app.on_event("startup")
async def startup_event():
    # One broken folder must not take the others down, but a broken DEFAULT must,
    # because then there is nothing safe to fall back to.
    for model_dir in sorted(p for p in MODEL_ROOT.iterdir() if (p / MODEL_FILE).exists()):
        try:
            registry[model_dir.name] = load_entry(model_dir)
            print(f"Model {model_dir.name} loaded (version {registry[model_dir.name]['version']}, "
                  f"{len(registry[model_dir.name]['classes'])} classes)")
        except Exception as e:
            load_errors[model_dir.name] = str(e)
            print(f"Model {model_dir.name} SKIPPED: {e}")

    if DEFAULT_MODEL_ID not in registry:
        raise RuntimeError(
            f"default model '{DEFAULT_MODEL_ID}' is not loaded "
            f"(loaded: {sorted(registry)}, errors: {load_errors})")


def resolve(model_id: Optional[str]) -> dict:
    """Header value -> loaded entry. No header means the default; an unknown id is a 404."""
    if not registry:
        raise HTTPException(status_code=503, detail="Model not loaded")
    key = (model_id or "").strip() or DEFAULT_MODEL_ID
    entry = registry.get(key)
    if entry is None:
        raise HTTPException(status_code=404,
                            detail=f"Unknown model '{key}'. Available: {sorted(registry)}")
    return {"model_id": key, **entry}


class Prediction(BaseModel):
    class_id: int
    scientific_name: str
    confidence: float

class PredictResponse(BaseModel):
    predictions: List[Prediction]
    top_k: int
    inference_ms: int
    model_id: str
    model_version: str

class AvailableModel(BaseModel):
    model_id: str
    model_version: str
    num_classes: int
    input_shape: List[Optional[int]]
    is_default: bool

class ModelInfoResponse(BaseModel):
    model_id: str
    model_version: str
    input_shape: List[Optional[int]]   # batch dimension is None, so plain List[int] would reject it
    num_classes: int
    classes: dict
    available_models: List[AvailableModel]
    load_errors: Dict[str, str]

@app.get("/health")
async def health_check():
    return {"status": "healthy" if registry else "unhealthy", "model_loaded": bool(registry),
            "default_model_id": DEFAULT_MODEL_ID, "models": sorted(registry), "load_errors": load_errors}

@app.post("/predict", response_model=PredictResponse)
async def predict(
    image: UploadFile = File(...),
    top_k: int = Form(5, ge=1, le=50),
    x_model_id: Optional[str] = Header(None)
):
    entry = resolve(x_model_id)

    if not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    try:
        image_bytes = await image.read()
        img = preprocess_image(image_bytes, entry["cfg"])      # per-model preprocessing
        start_time = time.time()
        predictions = predict_image(entry["model"], img, entry["classes"], top_k)
        inference_ms = int((time.time() - start_time) * 1000)

        return PredictResponse(
            predictions=predictions,
            top_k=top_k,
            inference_ms=inference_ms,
            model_id=entry["model_id"],
            model_version=entry["version"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")

@app.post("/predict/batch")
async def predict_batch_endpoint(
    images: List[UploadFile] = File(...),
    top_k: int = Form(5, ge=1, le=50),
    x_model_id: Optional[str] = Header(None)
):
    entry = resolve(x_model_id)

    try:
        results = []
        for image in images:
            if not image.content_type.startswith("image/"):
                results.append({"error": "File must be an image"})
                continue
            image_bytes = await image.read()
            img = preprocess_image(image_bytes, entry["cfg"])
            predictions = predict_image(entry["model"], img, entry["classes"], top_k)
            results.append({"predictions": predictions})
        return {"results": results, "top_k": top_k,
                "model_id": entry["model_id"], "model_version": entry["version"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch prediction failed: {str(e)}")

@app.get("/model/info", response_model=ModelInfoResponse)
async def model_info(x_model_id: Optional[str] = Header(None)):
    entry = resolve(x_model_id)

    info = get_model_info(entry["model"], entry["classes"], entry["version"])
    available = [
        AvailableModel(
            model_id=mid,
            model_version=e["version"],
            num_classes=len(e["classes"]),
            input_shape=list(input_shape_of(e["model"])),
            is_default=(mid == DEFAULT_MODEL_ID),
        )
        for mid, e in sorted(registry.items())
    ]
    return ModelInfoResponse(model_id=entry["model_id"], available_models=available,
                             load_errors=load_errors, **info)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
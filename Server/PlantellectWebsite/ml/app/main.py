from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import os
import json
import time
from predict import load_model, predict_image, predict_batch, get_model_info
from preprocess import preprocess_image

app = FastAPI(
    title="Plantellect ML Inference Service",
    description="TensorFlow/Keras plant identification model inference API",
    version="1.0.0"
)

MODEL_PATH = os.getenv("MODEL_PATH", "/app/model/main/best_model.keras")
CLASSES_PATH = os.getenv("CLASSES_PATH", "/app/model/main/classes.json")

model = None
class_names = None

@app.on_event("startup")
async def startup_event():
    global model, class_names
    model = load_model(MODEL_PATH)
    with open(CLASSES_PATH, "r") as f:
        class_names = json.load(f)
    print(f"Model loaded from {MODEL_PATH}")
    print(f"Classes loaded: {len(class_names)}")

class Prediction(BaseModel):
    class_id: int
    scientific_name: str
    common_name: str
    confidence: float

class PredictResponse(BaseModel):
    predictions: List[Prediction]
    top_k: int
    inference_ms: int
    model_version: str

class ModelInfoResponse(BaseModel):
    model_version: str
    input_shape: List[int]
    num_classes: int
    classes: dict

@app.get("/health")
async def health_check():
    return {"status": "healthy", "model_loaded": model is not None}

@app.post("/predict", response_model=PredictResponse)
async def predict(
    image: UploadFile = File(...),
    top_k: int = Form(5)
):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    try:
        image_bytes = await image.read()
        img = preprocess_image(image_bytes)
        start_time = time.time()
        predictions = predict_image(model, img, class_names, top_k)
        inference_ms = int((time.time() - start_time) * 1000)
        
        return PredictResponse(
            predictions=predictions,
            top_k=top_k,
            inference_ms=inference_ms,
            model_version="v1.0.0"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")

@app.post("/predict/batch")
async def predict_batch_endpoint(
    images: List[UploadFile] = File(...),
    top_k: int = Form(5)
):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    try:
        results = []
        for image in images:
            if not image.content_type.startswith("image/"):
                results.append({"error": "File must be an image"})
                continue
            image_bytes = await image.read()
            img = preprocess_image(image_bytes)
            predictions = predict_image(model, img, class_names, top_k)
            results.append({"predictions": predictions})
        return {"results": results, "top_k": top_k}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch prediction failed: {str(e)}")

@app.get("/model/info", response_model=ModelInfoResponse)
async def model_info():
    if model is None or class_names is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    info = get_model_info(model, class_names)
    return ModelInfoResponse(**info)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
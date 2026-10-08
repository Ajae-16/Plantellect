import tensorflow as tf
import numpy as np
from typing import List, Dict, Any


def load_model(model_path: str) -> tf.keras.Model:
    """
    Load the trained Keras model.

    Args:
        model_path: Path to the .keras model file

    Returns:
        Loaded Keras model
    """
    try:
        model = tf.keras.models.load_model(model_path)
        return model
    except Exception as e:
        raise RuntimeError(f"Failed to load model from {model_path}: {str(e)}")


def input_shape_of(model: tf.keras.Model):
    """Model input shape, tolerating multi-input models (uses the first input)."""
    shape = model.input_shape
    if isinstance(shape, list):
        shape = shape[0]
    return shape


def check_model_output(model: tf.keras.Model, class_names: Dict[str, Any]) -> None:
    """
    Call once at startup. The confidence thresholds on the Node side only mean
    something if the model outputs softmax PROBABILITIES for exactly the classes
    in classes.json, so fail loudly here instead of serving meaningless scores.
    """
    out = model.output_shape
    if isinstance(out, list):
        out = out[0]
    if out[-1] != len(class_names):
        raise ValueError(
            f"model outputs {out[-1]} classes but classes.json has {len(class_names)}. "
            "The wrong classes.json is paired with this model.")

    h, w = input_shape_of(model)[1], input_shape_of(model)[2]
    probe = np.random.default_rng(0).uniform(0, 255, (1, h, w, 3)).astype(np.float32)
    p = model.predict(probe, verbose=0)[0]
    # Loose tolerance so mixed-precision models do not trip it.
    if p.min() < 0 or p.max() > 1 or abs(float(p.sum()) - 1.0) > 1e-2:
        raise ValueError(
            "model output is not a softmax probability vector (values outside 0-1 or "
            "sum != 1). Confidence thresholds would be meaningless; add a softmax "
            "layer or export the model with one.")


def _format_top_k(
    predictions: np.ndarray,
    class_names: Dict[str, Dict[str, str]],
    top_k: int
) -> List[Dict[str, Any]]:
    """One probability vector -> top-k result dicts, confidence descending."""
    top_indices = np.argsort(predictions)[::-1][:top_k]
    results = []
    for idx in top_indices:
        class_id = int(idx)
        class_info = class_names.get(str(class_id), {"scientific": "Unknown", "common": "Unknown"})
        results.append({
            "class_id": class_id,
            "scientific_name": class_info.get("scientific", "Unknown"),
            "confidence": float(predictions[idx])
        })
    return results


def predict_image(
    model: tf.keras.Model,
    image: np.ndarray,
    class_names: Dict[str, Dict[str, str]],
    top_k: int = 5
) -> List[Dict[str, Any]]:
    """
    Run inference on a single preprocessed image.

    Args:
        model: Loaded Keras model
        image: Preprocessed image array with shape (1, H, W, 3)
        class_names: Dictionary mapping class indices to {scientific, common} names
        top_k: Number of top predictions to return

    Returns:
        List of prediction dictionaries sorted by confidence descending
    """
    predictions = model.predict(image, verbose=0)[0]
    return _format_top_k(predictions, class_names, top_k)


def predict_batch(
    model: tf.keras.Model,
    images: List[np.ndarray],
    class_names: Dict[str, Dict[str, str]],
    top_k: int = 5
) -> List[List[Dict[str, Any]]]:
    """
    Run inference on a batch of preprocessed images.

    Returns:
        List of prediction lists (one per image)
    """
    batch = np.vstack(images)
    batch_predictions = model.predict(batch, verbose=0)
    return [_format_top_k(p, class_names, top_k) for p in batch_predictions]


def get_model_info(
    model: tf.keras.Model,
    class_names: Dict[str, Dict[str, str]],
    model_version: str = "unversioned"
) -> Dict[str, Any]:
    """
    Get model metadata.

    Args:
        model: Loaded Keras model
        class_names: Dictionary mapping class indices to {scientific, common} names
        model_version: Identifier of the loaded model (logged with every scan)
    """
    input_shape = input_shape_of(model)

    return {
        "model_version": model_version,
        "input_shape": list(input_shape) if input_shape else [None, 224, 224, 3],
        "num_classes": len(class_names),
        "classes": class_names
    }
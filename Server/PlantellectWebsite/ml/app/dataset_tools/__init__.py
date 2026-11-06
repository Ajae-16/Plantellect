"""Plantellect dataset tools.

Stage 1: scan + index + audit a dataset folder (read-only).
Stage 2: group photos and build a leak-free train/val/test snapshot.
Runs inside the FastAPI container (it has TensorFlow); see README.md.
"""

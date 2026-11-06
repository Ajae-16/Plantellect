"""Which plant does an unassigned ("Other plant") photo look like? Pure functions over vectors; no web framework.

Inputs are L2-normalised vectors, so a dot product is a cosine similarity.

suggest():  for each candidate photo (or group centroid), rank the plants by how close it is to THEIR photos.
            score = mean of the best `knn` similarities to that plant's photos (fewer when the plant has fewer),
            best  = the single closest photo.
            A mean of the closest few, not one centroid, because one species is often several looks (leaves, whole
            plant, flowers) and a centroid of all of them is far from each. `margin` is the gap between the first
            and second plant: a small gap means the model could not tell them apart, so the admin should look.
cluster():  group the candidates that look alike, so a whole batch can be moved at once. LEADER clustering, as in
            groups.py: a photo joins a group only if it is close to that group's FIRST photo, and a group stops at
            `cap` photos, so a chain of look-alikes can never snowball into one giant group.

The numbers are only as meaningful as the embedder. They are a guide for a person, never an automatic decision:
nothing here moves a photo.
"""
import numpy as np

DEFAULT_KNN = 3


def _unit(v):
    v = np.asarray(v, dtype="float32")
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def suggest(queries, references, vecs, top_k=3, knn=DEFAULT_KNN):
    """queries: {id: vector}. references: {plantId: [photo key]}. vecs: {photo key: vector}.

    Returns {id: [{plantId, score, best, refs, margin}]}, best plant first, at most top_k each. A plant whose
    photos have no vector yet is skipped (the caller reports how many are missing). `margin` is on the first entry."""
    plants, mats = [], []
    for plant_id, keys in references.items():
        rows = [vecs[k] for k in keys if k in vecs]
        if rows:
            plants.append(plant_id)
            mats.append(np.stack(rows).astype("float32"))
    out = {}
    for qid, q in queries.items():
        q = _unit(q)
        scored = []
        for plant_id, mat in zip(plants, mats):
            sims = mat @ q
            top = np.sort(sims)[::-1][:max(1, knn)]
            scored.append({"plantId": plant_id, "score": round(float(top.mean()), 4), "best": round(float(top[0]), 4), "refs": int(len(sims))})
        scored.sort(key=lambda r: (-r["score"], r["plantId"]))
        scored = scored[:max(1, top_k)]
        if scored:
            scored[0]["margin"] = round(scored[0]["score"] - (scored[1]["score"] if len(scored) > 1 else 0.0), 4)
        out[qid] = scored
    return out


def cluster(vecs, threshold=0.80, cap=60):
    """vecs: {id: vector}. Returns groups, largest first: [{ids, size, cohesion, centroid}].

    cohesion = mean similarity of the members to the group's centroid (1.0 = identical)."""
    ids = sorted(vecs)
    leaders = []            # (leader vector, member ids)
    for pid in ids:
        v = _unit(vecs[pid])
        placed = False
        if leaders:
            sims = np.stack([lv for lv, _ in leaders]) @ v
            for k in np.argsort(-sims):
                if sims[k] < threshold:
                    break
                if len(leaders[k][1]) < cap:
                    leaders[k][1].append(pid)
                    placed = True
                    break
        if not placed:
            leaders.append((v, [pid]))
    groups = []
    for _, members in leaders:
        mat = np.stack([_unit(vecs[m]) for m in members])
        centroid = _unit(mat.mean(axis=0))
        groups.append({"ids": members, "size": len(members), "cohesion": round(float((mat @ centroid).mean()), 4), "centroid": centroid})
    groups.sort(key=lambda g: (-g["size"], g["ids"][0]))
    return groups

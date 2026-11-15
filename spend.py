"""fal spend log + tonight's budget guard (output/fal_spend.json).

Prices checked on the fal model pages on 2026-11-15:
  kling-video/v2.1/standard/image-to-video : $0.28 for 5 s, +$0.056 per extra second
  kling-video/v2.5-turbo/pro/image-to-video: $0.35 for 5 s, +$0.07 per extra second
"""
import json, os, time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "output", "fal_spend.json")
BUDGET = float(os.environ.get("FAL_BUDGET_USD", "12"))
PRICES = {  # model -> (price for first 5 s, price per extra second)
    "fal-ai/kling-video/v2.1/standard/image-to-video": (0.28, 0.056),
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": (0.35, 0.07),
}


class BudgetExceeded(RuntimeError):
    pass


def estimate(model, seconds):
    base, extra = PRICES[model]
    return round(base + max(0, seconds - 5) * extra, 3)


def load():
    try:
        return json.load(open(LOG, encoding="utf-8"))
    except (OSError, ValueError):
        return {"budget_usd": BUDGET, "total_usd": 0.0, "calls": []}


def guard(model, seconds):
    d = load()
    est = estimate(model, seconds)
    if d["total_usd"] + est > BUDGET:
        raise BudgetExceeded(f"fal budget: spent ${d['total_usd']:.2f}, next call ${est:.2f}, limit ${BUDGET:.2f}")


def record(model, seconds, guide_id, step):
    d = load()
    est = estimate(model, seconds)
    d["calls"].append({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": model, "seconds": seconds,
                       "est_usd": est, "guide_id": guide_id, "step": step})
    d["total_usd"] = round(d["total_usd"] + est, 3)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    json.dump(d, open(LOG, "w", encoding="utf-8"), indent=2)

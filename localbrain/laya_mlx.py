"""Laya's network in MLX, for Apple silicon.

Laya is a ModernBERT encoder with a small decision head (two transformer layers,
an option scorer and an act/escalate head; ``laya.common.DecisionModel``). This
file reimplements that forward pass in MLX and swaps it into a stock
``laya.Agent``, so tokenizing, option markers, temperatures and answer decoding
stay laya's own and only the matrix maths moves to MLX. ``python laya_mlx.py
--check`` compares it with laya's PyTorch forward on the same batches.
"""
import math
import os

import mlx.core as mx
import mlx.nn as nn
import numpy as np


class EncoderLayer(nn.Module):
    """One ModernBERT layer: pre-norm attention with RoPE (global or sliding), then a GLU MLP."""

    def __init__(self, d: int, heads: int, inter: int, eps: float, first: bool, theta: float, window: int | None):
        super().__init__()
        self.heads, self.window, self.theta, self.first = heads, window, theta, first
        if not first:
            self.attn_norm = nn.LayerNorm(d, eps=eps, bias=False)
        self.Wqkv = nn.Linear(d, 3 * d, bias=False)
        self.Wo = nn.Linear(d, d, bias=False)
        self.mlp_norm = nn.LayerNorm(d, eps=eps, bias=False)
        self.Wi = nn.Linear(d, 2 * inter, bias=False)
        self.Wo_mlp = nn.Linear(inter, d, bias=False)

    def __call__(self, x, masks):
        B, T, D = x.shape
        hd = D // self.heads
        h = x if self.first else self.attn_norm(x)
        qkv = self.Wqkv(h).reshape(B, T, 3, self.heads, hd).transpose(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]
        q = mx.fast.rope(q, hd, traditional=False, base=self.theta, scale=1.0, offset=0)
        k = mx.fast.rope(k, hd, traditional=False, base=self.theta, scale=1.0, offset=0)
        mask = masks["sliding" if self.window else "full"]
        a = mx.fast.scaled_dot_product_attention(q, k, v, scale=hd**-0.5, mask=mask)
        x = x + self.Wo(a.transpose(0, 2, 1, 3).reshape(B, T, D))
        inp, gate = mx.split(self.Wi(self.mlp_norm(x)), 2, axis=-1)
        return x + self.Wo_mlp(nn.gelu(inp) * gate)


class HeadLayer(nn.Module):
    """``nn.TransformerEncoderLayer(norm_first=True)``: relu feed-forward, biases everywhere."""

    def __init__(self, d: int, heads: int):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(d, eps=1e-5)
        self.norm2 = nn.LayerNorm(d, eps=1e-5)
        self.in_proj = nn.Linear(d, 3 * d)
        self.out_proj = nn.Linear(d, d)
        self.linear1 = nn.Linear(d, 4 * d)
        self.linear2 = nn.Linear(4 * d, d)

    def __call__(self, x, key_mask):
        B, T, D = x.shape
        hd = D // self.heads
        qkv = self.in_proj(self.norm1(x)).reshape(B, T, 3, self.heads, hd).transpose(2, 0, 3, 1, 4)
        a = mx.fast.scaled_dot_product_attention(qkv[0], qkv[1], qkv[2], scale=hd**-0.5, mask=key_mask)
        x = x + self.out_proj(a.transpose(0, 2, 1, 3).reshape(B, T, D))
        return x + self.linear2(nn.relu(self.linear1(self.norm2(x))))


class DecisionModel(nn.Module):
    def __init__(self, ecfg: dict, head_layers: int, n_act: int):
        super().__init__()
        d, eps = ecfg["hidden_size"], ecfg.get("norm_eps", 1e-5)
        rope = ecfg.get("rope_parameters") or {}
        g_theta = rope.get("full_attention", {}).get("rope_theta", ecfg.get("global_rope_theta", 160000.0))
        l_theta = rope.get("sliding_attention", {}).get("rope_theta", ecfg.get("local_rope_theta", 10000.0))
        every = ecfg.get("global_attn_every_n_layers", 3)
        types = ecfg.get("layer_types") or ["full_attention" if i % every == 0 else "sliding_attention" for i in range(ecfg["num_hidden_layers"])]
        self.half_window = ecfg.get("local_attention", 128) // 2
        self.tok_embeddings = nn.Embedding(ecfg["vocab_size"], d)
        self.emb_norm = nn.LayerNorm(d, eps=eps, bias=False)
        self.layers = [
            EncoderLayer(d, ecfg["num_attention_heads"], ecfg["intermediate_size"], eps, i == 0,
                         g_theta if t == "full_attention" else l_theta, None if t == "full_attention" else self.half_window)
            for i, t in enumerate(types)
        ]
        self.final_norm = nn.LayerNorm(d, eps=eps, bias=False)
        self.type_emb = nn.Embedding(3, d)
        self.head = [HeadLayer(d, max(1, d // 64)) for _ in range(head_layers)]
        self.scorer_norm = nn.LayerNorm(d, eps=1e-5)
        self.scorer1 = nn.Linear(d, d)
        self.scorer2 = nn.Linear(d, 1)
        self.act1 = nn.Linear(d + 4, 256)
        self.act2 = nn.Linear(256, n_act)

    def __call__(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
        B, T = input_ids.shape
        keep = attention_mask.astype(mx.bool_)[:, None, None, :]  # (B, 1, 1, T)
        pos = mx.arange(T)
        near = mx.abs(pos[:, None] - pos[None, :]) <= self.half_window
        masks = {"full": keep, "sliding": mx.logical_and(keep, near[None, None])}
        h = self.emb_norm(self.tok_embeddings(input_ids))
        for layer in self.layers:
            h = layer(h, masks)
        h = self.final_norm(h)
        h = h + self.type_emb(qtype)[:, None, :]
        for layer in self.head:
            h = layer(h, keep)
        idx = mx.maximum(marker_pos, 0)
        m = mx.take_along_axis(h, idx[:, :, None], axis=1)
        logits = self.scorer2(nn.gelu(self.scorer1(self.scorer_norm(m)))).squeeze(-1).astype(mx.float32)
        logits = mx.where(marker_mask, logits, -1e4)
        p = mx.softmax(logits, axis=-1)
        k = mx.maximum(marker_mask.sum(-1), 2).astype(mx.float32)
        ent = -(p * mx.log(mx.maximum(p, 1e-9))).sum(-1) / mx.log(k)
        top = mx.sort(p, axis=-1)[:, ::-1]
        top1 = top[:, 0]
        top2 = top[:, 1] if p.shape[-1] >= 2 else mx.zeros_like(top1)
        feats = mx.stack([top1, top1 - top2, ent, k / 255.0], axis=-1)
        act_in = mx.concatenate([h[:, 0].astype(mx.float32), feats], axis=-1)
        act = self.act2(nn.gelu(self.act1(act_in)))
        return logits, act


# laya's parameter names -> this module's.
def _rename(name: str) -> str | None:
    if name == "temperature":
        return None
    name = name.replace("encoder.embeddings.tok_embeddings", "tok_embeddings").replace("encoder.embeddings.norm", "emb_norm")
    name = name.replace("encoder.final_norm", "final_norm").replace("encoder.layers.", "layers.")
    name = name.replace(".attn.Wqkv", ".Wqkv").replace(".attn.Wo", ".Wo").replace(".mlp.Wi", ".Wi").replace(".mlp.Wo", ".Wo_mlp")
    name = name.replace("head.layers.", "head.").replace(".self_attn.in_proj_weight", ".in_proj.weight").replace(".self_attn.in_proj_bias", ".in_proj.bias").replace(".self_attn.out_proj", ".out_proj")
    name = name.replace("scorer.0", "scorer_norm").replace("scorer.1", "scorer1").replace("scorer.3", "scorer2")
    return name.replace("act_head.0", "act1").replace("act_head.2", "act2")


def load_mlx_model(model_dir: str, cfg: dict, dtype=mx.float16) -> DecisionModel:
    import json

    with open(os.path.join(model_dir, "encoder", "config.json")) as f:
        ecfg = json.load(f)
    model = DecisionModel(ecfg, cfg.get("head_layers", 2), len(cfg.get("act_costs", {})) + 1)
    weights = mx.load(os.path.join(model_dir, "model.safetensors"))
    # The act head reads fp32 features; keep it (and the scorer's output) in fp32.
    fp32 = ("act1", "act2")
    pairs = []
    for k, v in weights.items():
        n = _rename(k)
        if n is not None:
            pairs.append((n, v.astype(mx.float32 if n.startswith(fp32) else dtype)))
    model.load_weights(pairs, strict=True)
    model.eval()
    mx.eval(model.parameters())
    return model


class MLXAgent:
    """A ``laya.Agent`` (on CPU, for tokenizing and decoding) whose forward runs in MLX."""

    def __init__(self, checkpoint: str, revision: str | None = None, dtype=mx.float16):
        import laya
        import torch
        from huggingface_hub import snapshot_download

        self.agent = laya.load(checkpoint, revision=revision, device="cpu")
        model_dir = checkpoint if os.path.isdir(checkpoint) else snapshot_download(checkpoint, revision=revision, allow_patterns=["model.safetensors", "encoder/*"])
        self.mlx = load_mlx_model(model_dir, self.agent.cfg, dtype)

        def infer(b):
            out = self.mlx(*(mx.array(b[k].numpy()) for k in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")))
            mx.eval(out)
            return tuple(torch.from_numpy(np.array(t)) for t in out)

        self.agent._infer = infer

    def predict(self, state, questions, **kw):
        return self.agent.predict(state, questions, **kw)


def _check(checkpoint: str, revision: str | None) -> None:
    """MLX vs laya's own torch forward (CPU, fp32) on a few states."""
    import laya

    ref = laya.load(checkpoint, revision=revision, device="cpu")
    m = MLXAgent(checkpoint, revision)
    qs = {
        "level": {"type": "choice", "instructions": "How loud should the band play next?", "criteria": {"silent": "almost silent", "soft": "soft", "medium": "medium", "strong": "strong"}},
        "stopped": {"type": "noul", "instructions": "Has the player stopped playing?"},
        "how": {"type": "score", "instructions": "How busy is the player?", "criteria": ["not at all", "a bit", "a lot"]},
    }
    states = ["The player has stopped playing: 4 silent bars, no notes at all. The band is playing drums, bass and chords.",
              "The player is playing busy and loud, lots of notes, and getting louder. " * 12]
    worst = 0.0
    for s in states:
        a, b = ref.predict(s, qs), m.predict(s, qs)
        for q in qs:
            pa, pb = a["answers"][q].get("probabilities"), b["answers"][q].get("probabilities")
            if pa:
                d = max(abs(pa[k] - pb[k]) for k in pa)
            else:
                d = abs(a["answers"][q]["noul"] - b["answers"][q]["noul"])
            worst = max(worst, d)
            print(f"{q:8} torch={json_short(a['answers'][q])}  mlx={json_short(b['answers'][q])}  max|dp|={d:.4f}")
    print(f"worst probability difference: {worst:.4f}")


def json_short(a: dict) -> str:
    return str(a.get("choice") or a.get("score") or a.get("noul"))


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--checkpoint", default="convaiinnovations/laya")
    ap.add_argument("--revision", default=None)
    a = ap.parse_args()
    if a.check:
        _check(a.checkpoint, a.revision)

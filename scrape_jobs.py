import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

import requests
import yaml
from dateutil import parser as dateparser


def now_utc():
    return datetime.now(timezone.utc)


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def init_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        company TEXT,
        title TEXT NOT NULL,
        location TEXT,
        url TEXT NOT NULL,
        posted_at TEXT,
        first_seen_at TEXT NOT NULL,
        description TEXT,
        raw_json TEXT
    )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at)")
    conn.commit()


def upsert_job(conn: sqlite3.Connection, job: dict) -> bool:
    """
    Returns True if inserted (new), False if already existed.
    """
    cur = conn.execute("SELECT 1 FROM jobs WHERE id = ?", (job["id"],))
    if cur.fetchone():
        return False

    conn.execute("""
    INSERT INTO jobs (id, source, company, title, location, url, posted_at, first_seen_at, description, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        job["id"],
        job["source"],
        job.get("company"),
        job["title"],
        job.get("location"),
        job["url"],
        job.get("posted_at"),
        job["first_seen_at"],
        job.get("description"),
        json.dumps(job.get("raw", {}), ensure_ascii=False),
    ))
    return True


def normalize_text(s: str) -> str:
    return " ".join((s or "").lower().split())


def passes_filters(job: dict, filters: dict) -> bool:
    text = normalize_text(
        f'{job.get("title","")} {job.get("location","")} {job.get("description","")}'
    )

    keywords = [k.lower() for k in filters.get("keywords_any", [])]
    if keywords and not any(k in text for k in keywords):
        return False

    locations = [l.lower() for l in filters.get("location_any", [])]
    if locations:
        loc_text = normalize_text(job.get("location", ""))
        # allow "remote" to match even if location field is blank
        if loc_text and not any(l in loc_text for l in locations):
            # still allow if "remote" is in description/title
            if not any(l in text for l in locations):
                return False

    return True


def parse_dt(dt_str: str) -> str | None:
    if not dt_str:
        return None
    try:
        return dateparser.parse(dt_str).astimezone(timezone.utc).isoformat()
    except Exception:
        return None


# ---------- Greenhouse ----------
def fetch_greenhouse_jobs(board_token: str) -> list[dict]:
    # Public Greenhouse board API (no auth) commonly available:
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    data = r.json()
    out = []
    for j in data.get("jobs", []):
        job_url = j.get("absolute_url") or ""
        job_id = sha1(f"greenhouse|{board_token}|{job_url}")
        out.append({
            "id": job_id,
            "source": "greenhouse",
            "company": board_token,
            "title": j.get("title", "").strip(),
            "location": (j.get("location") or {}).get("name"),
            "url": job_url,
            "posted_at": parse_dt(j.get("updated_at") or j.get("created_at")),
            "description": j.get("content") or "",
            "raw": j,
        })
    return out


# ---------- Lever ----------
def fetch_lever_jobs(handle: str) -> list[dict]:
    # Public Lever postings API (no auth)
    url = f"https://api.lever.co/v0/postings/{handle}?mode=json"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    data = r.json()
    out = []
    for j in data:
        job_url = j.get("hostedUrl") or j.get("applyUrl") or ""
        job_id = sha1(f"lever|{handle}|{job_url}")
        categories = j.get("categories") or {}
        location = j.get("location") or categories.get("location")
        out.append({
            "id": job_id,
            "source": "lever",
            "company": handle,
            "title": (j.get("text") or "").strip(),
            "location": location,
            "url": job_url,
            "posted_at": parse_dt(j.get("createdAt")) if isinstance(j.get("createdAt"), str) else None,
            "description": j.get("descriptionPlain") or j.get("description") or "",
            "raw": j,
        })
    return out


def prune_old(conn: sqlite3.Connection, max_age_days: int) -> int:
    cutoff = (now_utc() - timedelta(days=max_age_days)).isoformat()
    cur = conn.execute("DELETE FROM jobs WHERE first_seen_at < ?", (cutoff,))
    return cur.rowcount


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--db", default="jobs.db")
    args = ap.parse_args()

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    filters = cfg.get("filters", {})
    max_age_days = int(cfg.get("dedupe", {}).get("max_age_days", 30))

    conn = sqlite3.connect(args.db)
    init_db(conn)

    inserted = 0
    checked = 0

    first_seen = now_utc().isoformat()

    sources = cfg.get("sources", {})

    # Greenhouse
    for token in sources.get("greenhouse", {}).get("boards", []) or []:
        try:
            jobs = fetch_greenhouse_jobs(token)
        except Exception as e:
            print(f"[WARN] Greenhouse {token} failed: {e}", file=sys.stderr)
            continue

        for job in jobs:
            checked += 1
            job["first_seen_at"] = first_seen
            if not job["title"] or not job["url"]:
                continue
            if not passes_filters(job, filters):
                continue
            if upsert_job(conn, job):
                inserted += 1

    # Lever
    for handle in sources.get("lever", {}).get("handles", []) or []:
        try:
            jobs = fetch_lever_jobs(handle)
        except Exception as e:
            print(f"[WARN] Lever {handle} failed: {e}", file=sys.stderr)
            continue

        for job in jobs:
            checked += 1
            job["first_seen_at"] = first_seen
            if not job["title"] or not job["url"]:
                continue
            if not passes_filters(job, filters):
                continue
            if upsert_job(conn, job):
                inserted += 1

    pruned = prune_old(conn, max_age_days)
    conn.commit()
    conn.close()

    print(f"Checked: {checked} | New inserted: {inserted} | Pruned old: {pruned}")


if __name__ == "__main__":
    main()

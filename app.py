import re
import sqlite3
from pathlib import Path

import pandas as pd
import streamlit as st

SUPPORTED_EXTENSIONS = {".txt", ".md", ".pdf", ".docx"}


def extract_text(uploaded_file) -> str:
    if not uploaded_file:
        return ""

    suffix = Path(uploaded_file.name).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        st.warning(f"Unsupported file type: {suffix}")
        return ""

    if suffix in {".txt", ".md"}:
        return uploaded_file.read().decode("utf-8", errors="ignore")

    if suffix == ".pdf":
        try:
            import PyPDF2
        except ImportError:
            st.error("PyPDF2 is required for PDF parsing. Install dependencies.")
            return ""
        reader = PyPDF2.PdfReader(uploaded_file)
        return "\n".join(page.extract_text() or "" for page in reader.pages)

    if suffix == ".docx":
        try:
            from docx import Document
        except ImportError:
            st.error("python-docx is required for DOCX parsing. Install dependencies.")
            return ""
        doc = Document(uploaded_file)
        return "\n".join(p.text for p in doc.paragraphs)

    return ""


def tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z0-9+#.-]+", text.lower())
    return [t for t in tokens if len(t) > 2]


def keyword_set(*texts: str) -> set[str]:
    keywords: set[str] = set()
    for text in texts:
        keywords.update(tokenize(text))
    return keywords


def score_job(job_text: str, keywords: set[str]) -> tuple[int, int]:
    if not keywords:
        return 0, 0
    job_text = job_text.lower()
    matched = sum(1 for k in keywords if k in job_text)
    score = round((matched / len(keywords)) * 100)
    return score, matched


def score_style(value: int) -> str:
    color = "green" if value > 50 else "red"
    return f"color: {color}; font-weight: 600;"


def load_jobs(db_path: str) -> list[dict]:
    if not Path(db_path).exists():
        st.error(f"Database not found at {db_path}")
        return []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, company, title, location, url, posted_at, description
        FROM jobs
        ORDER BY posted_at DESC
        """
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


st.set_page_config(page_title="Job Match Dashboard", layout="wide")
st.title("Job Match Dashboard")

with st.sidebar:
    st.header("Inputs")
    db_path = st.text_input("SQLite DB path", value="jobs.db")
    top_n = st.selectbox("Results to show", [5, 10], index=0)
    cv_file = st.file_uploader("Upload CV", type=["txt", "md", "pdf", "docx"])
    cover_file = st.file_uploader("Upload Cover Letter", type=["txt", "md", "pdf", "docx"])

cv_text = extract_text(cv_file)
cover_text = extract_text(cover_file)

keywords = keyword_set(cv_text, cover_text)

if keywords:
    st.caption(f"Extracted {len(keywords)} keywords from your documents.")
else:
    st.info("Upload your CV and cover letter to generate keyword matches.")

jobs = load_jobs(db_path)

if jobs and keywords:
    ranked = []
    for job in jobs:
        job_text = " ".join(
            str(job.get(field, "") or "")
            for field in ["title", "company", "location", "description"]
        )
        score, _ = score_job(job_text, keywords)
        ranked.append(
            {
                "score": score,
                "title": job.get("title"),
                "company": job.get("company"),
                "location": job.get("location"),
                "url": job.get("url"),
            }
        )

    ranked.sort(key=lambda item: item["score"], reverse=True)
    top_ranked = ranked[:top_n]
    top_ranked_df = pd.DataFrame(top_ranked).rename(
        columns={
            "score": "Relevance Score",
            "title": "Title",
            "company": "Company",
            "location": "Location",
            "url": "Posting Link",
        }
    )

    styled_ranked = top_ranked_df.style.applymap(score_style, subset=["Relevance Score"])

    st.subheader(f"Top {top_n} matches")
    st.dataframe(styled_ranked, use_container_width=True)
else:
    st.info("No jobs to display yet. Ensure the database has scraped jobs.")

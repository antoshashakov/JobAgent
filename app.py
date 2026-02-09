import io
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests
import streamlit as st
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

LINK_STORE = Path("user_links.json")
API_KEY_STORE = Path("user_api_key.json")
GOOGLE_DOC_PATTERN = re.compile(r"docs.google.com/document/d/([a-zA-Z0-9_-]+)")


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


def load_links() -> dict[str, str]:
    if LINK_STORE.exists():
        return json.loads(LINK_STORE.read_text(encoding="utf-8"))
    return {"cv": "", "cover": ""}


def save_links(links: dict[str, str]) -> None:
    LINK_STORE.write_text(json.dumps(links, indent=2), encoding="utf-8")


def load_api_key() -> str:
    if API_KEY_STORE.exists():
        payload = json.loads(API_KEY_STORE.read_text(encoding="utf-8"))
        return payload.get("api_key", "")
    return ""


def save_api_key(api_key: str) -> None:
    API_KEY_STORE.write_text(
        json.dumps({"api_key": api_key}, indent=2),
        encoding="utf-8",
    )


def extract_google_doc_id(link: str) -> str | None:
    match = GOOGLE_DOC_PATTERN.search(link or "")
    return match.group(1) if match else None


@st.cache_data(show_spinner=False)
def fetch_google_doc_text(link: str) -> str:
    doc_id = extract_google_doc_id(link)
    if not doc_id:
        raise ValueError("Invalid Google Doc link. Ensure it's a shareable document URL.")
    export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
    response = requests.get(export_url, timeout=30)
    response.raise_for_status()
    return response.text


def create_pdf_bytes(title: str, body: str) -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    width, height = letter
    text_object = pdf.beginText(50, height - 60)
    text_object.setFont("Helvetica-Bold", 14)
    text_object.textLine(title)
    text_object.setFont("Helvetica", 11)
    text_object.textLine(" ")
    for line in body.splitlines():
        if text_object.getY() < 60:
            pdf.drawText(text_object)
            pdf.showPage()
            text_object = pdf.beginText(50, height - 60)
            text_object.setFont("Helvetica", 11)
        text_object.textLine(line)
    pdf.drawText(text_object)
    pdf.showPage()
    pdf.save()
    buffer.seek(0)
    return buffer.read()


def openai_generate_document(
    api_key: str,
    model: str,
    document_type: str,
    job: dict,
    cv_text: str,
    cover_text: str,
) -> str:
    prompt = f"""
You are updating a {document_type} for a job application.

Rules:
- Use ONLY the candidate's existing experience and facts. Never invent or exaggerate.
- Preserve the candidate's voice, tone, and formatting as much as possible.
- Make the {document_type} more relevant to the job posting using only existing information.
- Fix grammar and professionalism issues, but avoid unnecessary changes.
- Output plain text only, no markdown.

Job posting:
Title: {job.get('title')}
Company: {job.get('company')}
Location: {job.get('location')}
Description:
{job.get('description')}

Candidate CV:
{cv_text}

Candidate Cover Letter:
{cover_text}
""".strip()

    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that edits job application documents.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        },
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"].strip()


st.set_page_config(page_title="Job Match Dashboard", layout="wide")
st.title("Job Match Dashboard")

status_messages = st.session_state.setdefault("status_messages", [])
status_placeholder = st.sidebar.empty()


def add_status(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    status_messages.append(f"[{timestamp}] {message}")
    status_placeholder.markdown("\n".join(f"- {msg}" for msg in status_messages[-6:]))


with st.sidebar:
    st.header("Inputs")
    db_path = st.text_input("SQLite DB path", value="jobs.db")
    stored_api_key = load_api_key()
    replace_api_key = st.checkbox(
        "Replace saved OpenAI API key",
        value=not stored_api_key,
    )
    api_key = stored_api_key
    if replace_api_key:
        api_key = st.text_input(
            "OpenAI API key",
            type="password",
            value=stored_api_key,
        )
    else:
        st.caption(
            "Using saved OpenAI API key. Check the box above to update it."
        )
    if st.button("Save API key"):
        if not api_key.strip():
            st.error("Enter an API key before saving.")
        else:
            save_api_key(api_key.strip())
            add_status("Saved OpenAI API key locally.")
            st.success("API key saved locally.")
    model_name = st.text_input("OpenAI model", value="gpt-4o-mini")
    st.divider()
    st.subheader("Generation status")

stored_links = load_links()


st.header("Step 1: CV and cover letter links")
st.caption("Provide shareable Google Doc links so they can be reused on future runs.")

replace_cv = st.checkbox("Replace CV link", value=not stored_links.get("cv"))
replace_cover = st.checkbox(
    "Replace cover letter link", value=not stored_links.get("cover")
)

cv_link_input = stored_links.get("cv", "")
cover_link_input = stored_links.get("cover", "")

if replace_cv:
    cv_link_input = st.text_input("CV Google Doc link", value=cv_link_input)
else:
    st.write(f"Current CV link: {cv_link_input or 'Not set'}")

if replace_cover:
    cover_link_input = st.text_input("Cover letter Google Doc link", value=cover_link_input)
else:
    st.write(f"Current cover letter link: {cover_link_input or 'Not set'}")

if st.button("Save links"):
    updated_links = {
        "cv": cv_link_input.strip(),
        "cover": cover_link_input.strip(),
    }
    save_links(updated_links)
    fetch_google_doc_text.clear()
    add_status("Saved CV and cover letter links locally.")
    st.success("Links saved. Proceed to matching.")
    stored_links = updated_links

st.divider()
st.header("Step 2: Top 5 job matches")

cv_text = ""
cover_text = ""
if stored_links.get("cv") and stored_links.get("cover"):
    try:
        with st.spinner("Fetching CV text..."):
            cv_text = fetch_google_doc_text(stored_links["cv"])
        with st.spinner("Fetching cover letter text..."):
            cover_text = fetch_google_doc_text(stored_links["cover"])
    except (requests.RequestException, ValueError) as exc:
        st.error(f"Unable to fetch Google Doc content: {exc}")
        add_status("Failed to fetch Google Doc content. Check links and sharing settings.")
else:
    st.info("Add both links above to enable matching and generation.")

keywords = keyword_set(cv_text, cover_text)

if keywords:
    st.caption(f"Extracted {len(keywords)} keywords from your documents.")
else:
    st.info("Add your CV and cover letter links to generate keyword matches.")

jobs = load_jobs(db_path)

generated_docs = st.session_state.setdefault("generated_docs", {})

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
                "id": job.get("id"),
                "score": score,
                "title": job.get("title"),
                "company": job.get("company"),
                "location": job.get("location"),
                "url": job.get("url"),
                "description": job.get("description"),
            }
        )

    ranked.sort(key=lambda item: item["score"], reverse=True)
    top_ranked = ranked[:5]
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

    st.subheader("Top 5 matches")
    st.dataframe(styled_ranked, use_container_width=True)

    for job in top_ranked:
        job_id = job["id"]
        st.markdown("---")
        st.markdown(
            f"**{job['title']}** at **{job['company']}**  \n"
            f"Location: {job['location']}  \n"
            f"[View posting]({job['url']})"
        )
        col_cv, col_cover, col_download = st.columns([1, 1, 2])

        with col_cv:
            if st.button("Generate CV", key=f"cv_{job_id}"):
                if not api_key:
                    st.error("Add your OpenAI API key in the sidebar.")
                else:
                    add_status(f"Generating CV for {job['title']}...")
                    try:
                        cv_generated = openai_generate_document(
                            api_key,
                            model_name,
                            "CV",
                            job,
                            cv_text,
                            cover_text,
                        )
                        pdf_bytes = create_pdf_bytes(
                            f"CV - {job['title']} at {job['company']}",
                            cv_generated,
                        )
                        generated_docs.setdefault(job_id, {})["cv"] = {
                            "text": cv_generated,
                            "pdf": pdf_bytes,
                        }
                        add_status("CV generation complete.")
                    except requests.RequestException as exc:
                        st.error(f"CV generation failed: {exc}")
                        add_status("CV generation failed.")

        with col_cover:
            if st.button("Generate cover letter", key=f"cover_{job_id}"):
                if not api_key:
                    st.error("Add your OpenAI API key in the sidebar.")
                else:
                    add_status(f"Generating cover letter for {job['title']}...")
                    try:
                        cover_generated = openai_generate_document(
                            api_key,
                            model_name,
                            "cover letter",
                            job,
                            cv_text,
                            cover_text,
                        )
                        pdf_bytes = create_pdf_bytes(
                            f"Cover Letter - {job['title']} at {job['company']}",
                            cover_generated,
                        )
                        generated_docs.setdefault(job_id, {})["cover"] = {
                            "text": cover_generated,
                            "pdf": pdf_bytes,
                        }
                        add_status("Cover letter generation complete.")
                    except requests.RequestException as exc:
                        st.error(f"Cover letter generation failed: {exc}")
                        add_status("Cover letter generation failed.")

        with col_download:
            doc_outputs = generated_docs.get(job_id, {})
            if doc_outputs.get("cv"):
                st.download_button(
                    "Download CV PDF",
                    data=doc_outputs["cv"]["pdf"],
                    file_name=f"cv_{job_id}.pdf",
                    mime="application/pdf",
                    key=f"download_cv_{job_id}",
                )
            if doc_outputs.get("cover"):
                st.download_button(
                    "Download cover letter PDF",
                    data=doc_outputs["cover"]["pdf"],
                    file_name=f"cover_letter_{job_id}.pdf",
                    mime="application/pdf",
                    key=f"download_cover_{job_id}",
                )
else:
    st.info("No jobs to display yet. Ensure the database has scraped jobs.")

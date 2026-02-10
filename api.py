"""
Simple Flask API server for the Job Agent extension.
Serves job data from the SQLite database and generates cover letters.
"""

import json
import sqlite3
from pathlib import Path
from flask import Flask, jsonify, request
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

DB_PATH = Path("jobs.db")


def get_jobs_from_db(limit: int = 5) -> list[dict]:
    """Fetch jobs from the database."""
    if not DB_PATH.exists():
        return []
    
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, company, title, location, url, posted_at, description
            FROM jobs
            ORDER BY posted_at DESC
            LIMIT ?
            """,
            (limit,)
        ).fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except Exception as e:
        print(f"Database error: {e}")
        return []


@app.route('/api/jobs/top5', methods=['GET'])
def get_top_jobs():
    """Get top 5 most recent jobs."""
    jobs = get_jobs_from_db(5)
    return jsonify({
        'success': True,
        'jobs': jobs,
        'count': len(jobs)
    })


@app.route('/api/jobs', methods=['GET'])
def get_all_jobs():
    """Get all jobs."""
    max_results = request.args.get('limit', 100, type=int)
    jobs = get_jobs_from_db(max_results)
    return jsonify({
        'success': True,
        'jobs': jobs,
        'count': len(jobs)
    })


@app.route('/api/jobs/<int:job_id>', methods=['GET'])
def get_job(job_id):
    """Get a specific job by ID."""
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, company, title, location, url, posted_at, description FROM jobs WHERE id = ?",
            (job_id,)
        ).fetchone()
        conn.close()
        
        if not row:
            return jsonify({'success': False, 'error': 'Job not found'}), 404
        
        return jsonify({'success': True, 'job': dict(row)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({'status': 'ok'})


def openai_generate_document(
    api_key: str,
    model: str,
    document_type: str,
    job: dict,
    source_text: str,
) -> str:
    """Generate a document (cover letter, etc.) using OpenAI."""
    prompt = f"""
You are updating a {document_type} for a job application.

Rules:
- Use ONLY the candidate's existing experience and facts. Never invent or exaggerate.
- Preserve the candidate's voice, tone, and formatting as much as possible.
- Make the {document_type} more relevant to the job posting using only existing information.
- Fix grammar and professionalism issues, but avoid unnecessary changes.
- Keep line breaks and formatting using these markers only:
  - Bold: **text**
  - Italic: *text*
  - Bold + italic: ***text***
- Output plain text with the markers above. Do not add markdown headings or lists.
- Use only the provided {document_type} text. Do not add content from other documents.
- If editing a cover letter, do NOT include a standalone job title heading at the top.

Job posting:
Title: {job.get('title')}
Company: {job.get('company')}
Location: {job.get('location')}
Description:
{job.get('description')}

Candidate {document_type}:
{source_text}
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


@app.route('/api/generate-cover-letter', methods=['POST'])
def generate_cover_letter():
    """Generate a personalized cover letter for a job."""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'success': False, 'error': 'No data provided'}), 400
        
        # Required fields
        api_key = data.get('api_key')
        model = data.get('model', 'gpt-4o-mini')
        job_id = data.get('job_id')
        cv_text = data.get('cv_text')
        cover_template = data.get('cover_template')
        
        if not all([api_key, job_id, cv_text, cover_template]):
            return jsonify({
                'success': False,
                'error': 'Missing required fields: api_key, job_id, cv_text, cover_template'
            }), 400
        
        # Get job details
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        job_row = conn.execute(
            "SELECT id, company, title, location, url, description FROM jobs WHERE id = ?",
            (job_id,)
        ).fetchone()
        conn.close()
        
        if not job_row:
            return jsonify({'success': False, 'error': 'Job not found'}), 404
        
        job = dict(job_row)
        
        # Generate cover letter
        try:
            cover_letter = openai_generate_document(
                api_key,
                model,
                "cover letter",
                job,
                cover_template
            )
            
            return jsonify({
                'success': True,
                'cover_letter': cover_letter,
                'job': job
            })
        except requests.RequestException as e:
            return jsonify({
                'success': False,
                'error': f'OpenAI API error: {str(e)}'
            }), 500
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


if __name__ == '__main__':
    app.run(debug=False, host='127.0.0.1', port=5000)

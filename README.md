# Job Match GUI

This repository contains a job scraper (`scrape_jobs.py`) and a Streamlit-based GUI (`app.py`) that ranks scraped postings against keywords found in your CV and cover letter.

## Run the scraper

```bash
python scrape_jobs.py --config config.yaml --db jobs.db
```

## Run the GUI in your browser

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Start the Streamlit app:

```bash
streamlit run app.py
```

3. Open the app in your browser:

Streamlit will print a local URL such as `http://localhost:8501`. Visit that address to use the GUI.

## Notes

- The GUI expects the SQLite database created by the scraper (`jobs.db` by default).
- Upload your CV and cover letter, then choose the top 5 or top 10 results to view scored matches.

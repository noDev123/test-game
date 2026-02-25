from playwright.sync_api import sync_playwright
from http.server import HTTPServer, BaseHTTPRequestHandler
import re
import time
import threading

cache = {'data': None}

def scrape():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("https://endfieldtools.dev/headhunt-tracker/#global", wait_until="networkidle")
        page.wait_for_timeout(8000)
        
        content = page.inner_text("body")
        stats = {}
        
        pulls_match = re.search(r'Total Pulls\s*\n\s*([\d,]+\.?\d*\s*[MKmk]?)', content, re.IGNORECASE)
        stats['total_pulls'] = pulls_match.group(1).strip() if pulls_match else 'Not found'
        
        contrib_match = re.search(r'Contributors\s*\n\s*([\d,]+)', content, re.IGNORECASE)
        stats['contributors'] = contrib_match.group(1).strip() if contrib_match else 'Not found'
        
        rate6_match = re.search(r'6.?\s*rate\s*([\d.]+%)', content, re.IGNORECASE)
        stats['6star_rate'] = rate6_match.group(1).strip() if rate6_match else 'Not found'

        count6_match = re.search(r'([\d,]+)\s*\n\s*5.?\s*rate', content, re.IGNORECASE)
        stats['6star_count'] = count6_match.group(1).strip() if count6_match else 'Not found'

        rate5_match = re.search(r'5.?\s*rate\s*([\d.]+%)', content, re.IGNORECASE)
        stats['5star_rate'] = rate5_match.group(1).strip() if rate5_match else 'Not found'

        count5_match = re.search(r'([\d,]+)\s*\n\s*Last updated', content, re.IGNORECASE)
        stats['5star_count'] = count5_match.group(1).strip() if count5_match else 'Not found'
        
        browser.close()
        return stats

def background_scraper():
    while True:
        print(f"Scraping... ({time.strftime('%H:%M:%S')})")
        cache['data'] = scrape()
        print(f"Done. Next refresh in 30 min.")
        time.sleep(30 * 60)

# start background scraper thread
thread = threading.Thread(target=background_scraper, daemon=True)
thread.start()

# wait until first scrape is done before accepting requests
print("Doing initial scrape, please wait...")
while cache['data'] is None:
    time.sleep(1)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/stats':
            data = cache['data']
            text = (
                f"total-pulls: {data['total_pulls']}\n"
                f"contributors: {data['contributors']}\n"
                f"6star-rate: {data['6star_rate']}\n"
                f"6star-count: {data['6star_count']}\n"
                f"5star-rate: {data['5star_rate']}\n"
                f"5star-count: {data['5star_count']}\n"
            )
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(text.encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

print("Server running on http://localhost:8080/stats")
HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
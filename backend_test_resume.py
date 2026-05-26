#!/usr/bin/env python3
"""
§10 Continue Watching Resume Backend Tests
Tests the resume functionality with ffmpeg -ss and subtitle cue-shift:
  1. /api/realdebrid/resolve with ?start= parameter
  2. POST /api/stream/hls/session endpoint
  3. /api/subtitles/download with ?offset= parameter
"""

import requests
import time
import re
import sys

BASE_URL = "http://localhost:3000"
TIMEOUT_SHORT = 15
TIMEOUT_LONG = 60

def print_test(num, desc):
    print(f"\n{'='*80}")
    print(f"TEST #{num}: {desc}")
    print('='*80)

def print_pass(msg):
    print(f"✅ PASS: {msg}")

def print_fail(msg):
    print(f"❌ FAIL: {msg}")

def print_info(msg):
    print(f"ℹ️  INFO: {msg}")

# ============================================================================
# TASK 1: Resume-via-ffmpeg-ss — HLS sessions accept startOffset
# ============================================================================

def test_1a_resolver_no_start():
    """Test 1a: GET /api/realdebrid/resolve without start (backwards compatibility)"""
    print_test("1a", "Resolver without start parameter (backwards compatibility)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        print(f"Response keys: {list(data.keys())}")
        
        # Check success
        if not data.get('success'):
            print_fail(f"success is not true: {data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check probedOk
        if not data.get('probedOk'):
            print_fail(f"probedOk is not true: {data.get('probedOk')}")
            return False
        print_pass("probedOk === true")
        
        # Check quality contains [RD⚡]
        quality = data.get('quality', '')
        if not quality.startswith('[RD⚡]'):
            print_fail(f"quality doesn't start with '[RD⚡]': {quality}")
            return False
        print_pass(f"quality starts with '[RD⚡]': {quality[:100]}")
        
        # Check startOffset is 0 (NEW FIELD)
        start_offset = data.get('startOffset')
        if start_offset != 0:
            print_fail(f"startOffset is not 0: {start_offset}")
            return False
        print_pass("startOffset === 0 (new field, backwards compatible)")
        
        # Check directUrl is present at top level (NEW FIELD)
        direct_url = data.get('directUrl', '')
        if not direct_url:
            print_fail("directUrl is missing at top level")
            return False
        if 'comet.elfhosted.com/playback/' not in direct_url:
            print_fail(f"directUrl is not a comet playback URL: {direct_url}")
            return False
        print_pass(f"directUrl present at top level: {direct_url[:80]}...")
        
        # Check qualities array
        qualities = data.get('qualities', [])
        if not isinstance(qualities, list):
            print_fail(f"qualities is not an array: {type(qualities)}")
            return False
        print_pass(f"qualities is array with {len(qualities)} items")
        
        # Check each quality has BOTH streamUrl AND directUrl
        for i, q in enumerate(qualities):
            stream_url = q.get('streamUrl', '')
            if not re.match(r'^/api/stream/hls/[a-f0-9]{16}/index\.m3u8$', stream_url):
                print_fail(f"qualities[{i}] streamUrl doesn't match pattern: {stream_url}")
                return False
            
            q_direct_url = q.get('directUrl', '')
            if not q_direct_url:
                print_fail(f"qualities[{i}] missing directUrl")
                return False
            if 'comet.elfhosted.com/playback/' not in q_direct_url:
                print_fail(f"qualities[{i}] directUrl is not a comet playback URL: {q_direct_url}")
                return False
        print_pass("All qualities have BOTH streamUrl AND directUrl")
        
        # Check alternates is non-empty
        alternates = data.get('alternates', [])
        if not isinstance(alternates, list):
            print_fail(f"alternates is not an array: {type(alternates)}")
            return False
        if len(alternates) == 0:
            print_fail("alternates is empty")
            return False
        print_pass(f"alternates is non-empty array with {len(alternates)} items")
        
        print_pass("TEST 1a PASSED - Backwards compatibility verified")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1b_resolver_with_start():
    """Test 1b: GET /api/realdebrid/resolve with start=180 (resume integration)"""
    print_test("1b", "Resolver with start=180 (resume integration)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start=180"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        # Check success
        if not data.get('success'):
            print_fail(f"success is not true: {data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check startOffset is 180 (echoed back from input)
        start_offset = data.get('startOffset')
        if start_offset != 180:
            print_fail(f"startOffset is not 180: {start_offset}")
            return False
        print_pass("startOffset === 180 (echoed back from input)")
        
        # Check streamUrl is a fresh HLS session
        stream_url = data.get('streamUrl', '')
        if not re.match(r'^/api/stream/hls/[a-f0-9]{16}/index\.m3u8$', stream_url):
            print_fail(f"streamUrl doesn't match pattern: {stream_url}")
            return False
        print_pass(f"streamUrl is fresh HLS session: {stream_url}")
        
        # Check qualities all have directUrl
        qualities = data.get('qualities', [])
        for i, q in enumerate(qualities):
            if not q.get('directUrl'):
                print_fail(f"qualities[{i}] missing directUrl")
                return False
        print_pass(f"All {len(qualities)} qualities have directUrl")
        
        print_pass("TEST 1b PASSED - Resume integration verified")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1c_resolver_negative_start():
    """Test 1c: GET /api/realdebrid/resolve with start=-10 (negative clamped to 0)"""
    print_test("1c", "Resolver with start=-10 (negative clamped to 0)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start=-10"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 0 (clamped)
        start_offset = data.get('startOffset')
        if start_offset != 0:
            print_fail(f"startOffset is not 0: {start_offset}")
            return False
        print_pass("startOffset === 0 (negative input clamped)")
        
        print_pass("TEST 1c PASSED - Negative input clamped to 0")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1d_resolver_nan_start():
    """Test 1d: GET /api/realdebrid/resolve with start=abc (NaN clamped to 0)"""
    print_test("1d", "Resolver with start=abc (NaN clamped to 0)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start=abc"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 0 (clamped)
        start_offset = data.get('startOffset')
        if start_offset != 0:
            print_fail(f"startOffset is not 0: {start_offset}")
            return False
        print_pass("startOffset === 0 (NaN input clamped)")
        
        print_pass("TEST 1d PASSED - NaN input clamped to 0")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1e_resolver_over_24h_start():
    """Test 1e: GET /api/realdebrid/resolve with start=999999 (over 24h clamped to 86400)"""
    print_test("1e", "Resolver with start=999999 (over 24h clamped to 86400)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start=999999"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 86400 (clamped)
        start_offset = data.get('startOffset')
        if start_offset != 86400:
            print_fail(f"startOffset is not 86400: {start_offset}")
            return False
        print_pass("startOffset === 86400 (over-24h input clamped)")
        
        print_pass("TEST 1e PASSED - Over-24h input clamped to 86400")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1f_resolver_tv_regression():
    """Test 1f: TV regression - The Boys S01E01"""
    print_test("1f", "TV regression - The Boys S01E01 (no UNKNOWN in quality)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=tv&imdb=tt1190634&season=1&episode=1"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        # Check success
        if not data.get('success'):
            print_fail(f"success is not true: {data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check quality does NOT contain "UNKNOWN"
        quality = data.get('quality', '')
        if 'UNKNOWN' in quality.upper():
            print_fail(f"quality contains 'UNKNOWN': {quality}")
            return False
        print_pass(f"quality does NOT contain 'UNKNOWN': {quality[:100]}")
        
        # Check alternates present
        alternates = data.get('alternates', [])
        if len(alternates) == 0:
            print_fail("alternates is empty")
            return False
        print_pass(f"alternates present with {len(alternates)} items")
        
        # Check startOffset is 0 (no start param)
        start_offset = data.get('startOffset')
        if start_offset != 0:
            print_fail(f"startOffset is not 0: {start_offset}")
            return False
        print_pass("startOffset === 0")
        
        print_pass("TEST 1f PASSED - TV regression verified")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1g_post_session_invalid_url():
    """Test 1g: POST /api/stream/hls/session with invalid sourceUrl"""
    print_test("1g", "POST /api/stream/hls/session with invalid sourceUrl")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "https://evil.example.com/file.mp4",
            "start": 60
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            print_fail(f"Expected 400, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        error = data.get('error', '')
        if 'Comet' not in error or 'playback' not in error:
            print_fail(f"Error message doesn't mention 'Comet playback URL': {error}")
            return False
        print_pass(f"Returns 400 with error: {error}")
        
        print_pass("TEST 1g PASSED - Invalid sourceUrl rejected")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1h_post_session_no_url():
    """Test 1h: POST /api/stream/hls/session with no sourceUrl"""
    print_test("1h", "POST /api/stream/hls/session with no sourceUrl")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {"start": 60}
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            print_fail(f"Expected 400, got {resp.status_code}")
            return False
        
        print_pass("Returns 400 for missing sourceUrl")
        print_pass("TEST 1h PASSED - Missing sourceUrl rejected")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1i_post_session_http_url():
    """Test 1i: POST /api/stream/hls/session with http (not https)"""
    print_test("1i", "POST /api/stream/hls/session with http (not https)")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "http://comet.elfhosted.com/playback/x",
            "start": 60
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            print_fail(f"Expected 400, got {resp.status_code}")
            return False
        
        print_pass("Returns 400 for http URL (https required)")
        print_pass("TEST 1i PASSED - http URL rejected")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1j_post_session_valid_url():
    """Test 1j: POST /api/stream/hls/session with valid mocked URL"""
    print_test("1j", "POST /api/stream/hls/session with valid mocked URL")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "https://comet.elfhosted.com/playback/fake_token/video.mp4",
            "start": 120,
            "quality": "720p",
            "filename": "test.mp4",
            "sizeBytes": 1234
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        print(f"Response: {data}")
        
        # Check success
        if not data.get('success'):
            print_fail(f"success is not true: {data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check sessionId
        session_id = data.get('sessionId', '')
        if not re.match(r'^[a-f0-9]{16}$', session_id):
            print_fail(f"sessionId doesn't match pattern: {session_id}")
            return False
        print_pass(f"sessionId matches pattern: {session_id}")
        
        # Check streamUrl
        stream_url = data.get('streamUrl', '')
        expected_pattern = f'^/api/stream/hls/{session_id}/index\\.m3u8$'
        if not re.match(expected_pattern, stream_url):
            print_fail(f"streamUrl doesn't match pattern: {stream_url}")
            return False
        print_pass(f"streamUrl matches pattern: {stream_url}")
        
        # Check streamType
        if data.get('streamType') != 'hls':
            print_fail(f"streamType is not 'hls': {data.get('streamType')}")
            return False
        print_pass("streamType === 'hls'")
        
        # Check startOffset
        if data.get('startOffset') != 120:
            print_fail(f"startOffset is not 120: {data.get('startOffset')}")
            return False
        print_pass("startOffset === 120")
        
        print_pass("TEST 1j PASSED - Valid URL accepted, session created")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1k_post_session_negative_start():
    """Test 1k: POST /api/stream/hls/session with negative start"""
    print_test("1k", "POST /api/stream/hls/session with negative start")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "https://comet.elfhosted.com/playback/x",
            "start": -50
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 0 (clamped)
        if data.get('startOffset') != 0:
            print_fail(f"startOffset is not 0: {data.get('startOffset')}")
            return False
        print_pass("startOffset === 0 (negative clamped)")
        
        print_pass("TEST 1k PASSED - Negative start clamped to 0")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1l_post_session_nan_start():
    """Test 1l: POST /api/stream/hls/session with NaN start (omit start)"""
    print_test("1l", "POST /api/stream/hls/session with NaN start (omit start)")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "https://comet.elfhosted.com/playback/x"
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 0 (default)
        if data.get('startOffset') != 0:
            print_fail(f"startOffset is not 0: {data.get('startOffset')}")
            return False
        print_pass("startOffset === 0 (NaN/omitted defaults to 0)")
        
        print_pass("TEST 1l PASSED - NaN start defaults to 0")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_1m_post_session_over_24h_start():
    """Test 1m: POST /api/stream/hls/session with over-24h start"""
    print_test("1m", "POST /api/stream/hls/session with over-24h start")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": "https://comet.elfhosted.com/playback/x",
            "start": 999999
        }
        print(f"POST {url}")
        print(f"Payload: {payload}")
        
        resp = requests.post(url, json=payload, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        # Check startOffset is 86400 (clamped)
        if data.get('startOffset') != 86400:
            print_fail(f"startOffset is not 86400: {data.get('startOffset')}")
            return False
        print_pass("startOffset === 86400 (over-24h clamped)")
        
        print_pass("TEST 1m PASSED - Over-24h start clamped to 86400")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

# ============================================================================
# TASK 2: Subtitle cue-shift — /api/subtitles/download?offset=<seconds>
# ============================================================================

def get_valid_file_id():
    """Get a valid file_id from subtitle search"""
    print_info("Getting valid file_id from subtitle search...")
    
    try:
        # Try Fight Club with tmdb_id
        url = f"{BASE_URL}/api/subtitles/search?tmdb_id=550&type=movie&languages=en"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        if resp.status_code == 200:
            data = resp.json()
            # Check for 'results' key (actual format)
            results = data.get('results', [])
            if results and len(results) > 0:
                file_id = results[0].get('file_id')
                if file_id:
                    print_info(f"Found file_id: {file_id}")
                    return file_id
        
        # Try with imdb_id
        url = f"{BASE_URL}/api/subtitles/search?imdb_id=0137523&type=movie&languages=en"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        if resp.status_code == 200:
            data = resp.json()
            # Check for 'results' key (actual format)
            results = data.get('results', [])
            if results and len(results) > 0:
                file_id = results[0].get('file_id')
                if file_id:
                    print_info(f"Found file_id: {file_id}")
                    return file_id
        
        print_fail("Could not find valid file_id from subtitle search")
        return None
        
    except Exception as e:
        print_fail(f"Exception getting file_id: {e}")
        return None

def test_2a_subtitle_baseline(file_id):
    """Test 2a: GET /api/subtitles/download without offset (baseline)"""
    print_test("2a", "Subtitle download without offset (baseline)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False, None, None
        
        # Check Content-Type
        content_type = resp.headers.get('Content-Type', '')
        if 'text/vtt' not in content_type:
            print_fail(f"Wrong Content-Type: {content_type}")
            return False, None, None
        print_pass(f"Content-Type: {content_type}")
        
        # Check body starts with WEBVTT
        body = resp.text
        if not body.startswith('WEBVTT'):
            print_fail(f"Body doesn't start with 'WEBVTT': {body[:100]}")
            return False, None, None
        print_pass("Body starts with 'WEBVTT'")
        
        # Count cues (lines containing " --> ")
        cue_count = len(re.findall(r' --> ', body))
        print_pass(f"Cue count: {cue_count}")
        
        # Extract first cue timecode for comparison
        first_cue_match = re.search(r'(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})', body)
        first_cue = None
        if first_cue_match:
            first_cue = (first_cue_match.group(1), first_cue_match.group(2))
            print_info(f"First cue: {first_cue[0]} --> {first_cue[1]}")
        
        print_pass("TEST 2a PASSED - Baseline subtitle download working")
        return True, cue_count, first_cue
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False, None, None

def test_2b_subtitle_offset_zero(file_id, baseline_count):
    """Test 2b: GET /api/subtitles/download with offset=0 (explicit zero)"""
    print_test("2b", "Subtitle download with offset=0 (explicit zero)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=0"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        body = resp.text
        cue_count = len(re.findall(r' --> ', body))
        
        # Should be identical to baseline
        if cue_count != baseline_count:
            print_fail(f"Cue count {cue_count} != baseline {baseline_count}")
            return False
        print_pass(f"Cue count === baseline ({cue_count})")
        
        print_pass("TEST 2b PASSED - offset=0 identical to baseline")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def parse_timecode(tc):
    """Parse VTT timecode HH:MM:SS.mmm to seconds"""
    parts = tc.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s = float(parts[2])
    return h * 3600 + m * 60 + s

def test_2c_subtitle_offset_60(file_id, baseline_count, baseline_first_cue):
    """Test 2c: GET /api/subtitles/download with offset=60 (shift back 1 min)"""
    print_test("2c", "Subtitle download with offset=60 (shift back 1 min)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=60"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        body = resp.text
        cue_count = len(re.findall(r' --> ', body))
        
        # Cue count should be <= baseline (some may be dropped)
        if cue_count > baseline_count:
            print_fail(f"Cue count {cue_count} > baseline {baseline_count}")
            return False
        print_pass(f"Cue count {cue_count} <= baseline {baseline_count}")
        
        # Extract first cue timecode
        first_cue_match = re.search(r'(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})', body)
        if not first_cue_match:
            print_fail("No cues found in shifted subtitle")
            return False
        
        first_cue_start = first_cue_match.group(1)
        first_cue_end = first_cue_match.group(2)
        print_info(f"First cue after shift: {first_cue_start} --> {first_cue_end}")
        
        # Verify the first cue's start is >= 0 (no negative times)
        shifted_start_sec = parse_timecode(first_cue_start)
        if shifted_start_sec < 0:
            print_fail(f"First cue start is negative: {shifted_start_sec}s")
            return False
        print_pass(f"First cue start is valid: {shifted_start_sec}s >= 0")
        
        # The first cue after shift should be from a cue that was originally > 60s
        # After shifting by -60, it should be at (original - 60) seconds
        # For example, if original was at 124.891s, after shift it's at 64.891s
        # We can't verify the exact original position without parsing the full baseline,
        # but we can verify the shift makes sense: the first cue should be at a
        # reasonable position (not at the very beginning, since early cues were dropped)
        if shifted_start_sec < 1:
            print_fail(f"First cue start {shifted_start_sec}s is too early (expected > 1s since early cues should be dropped)")
            return False
        print_pass(f"First cue start {shifted_start_sec}s is reasonable (early cues were dropped)")
        
        print_pass("TEST 2c PASSED - offset=60 shifts cues correctly")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2d_subtitle_offset_130(file_id, baseline_count):
    """Test 2d: GET /api/subtitles/download with offset=130 (past first cue's end)"""
    print_test("2d", "Subtitle download with offset=130 (past first cue's end)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=130"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        body = resp.text
        cue_count = len(re.findall(r' --> ', body))
        
        # Cue count should be strictly < baseline (at least 1 cue dropped)
        if cue_count >= baseline_count:
            print_fail(f"Cue count {cue_count} >= baseline {baseline_count} (expected < baseline)")
            return False
        print_pass(f"Cue count {cue_count} < baseline {baseline_count} (at least 1 cue dropped)")
        
        # First surviving cue's start should be clamped to 00:00:00.xxx if original < 130s
        first_cue_match = re.search(r'(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})', body)
        if first_cue_match:
            first_cue_start = first_cue_match.group(1)
            print_info(f"First surviving cue start: {first_cue_start}")
            # Should start at 00:00:00.xxx or later
            if not first_cue_start.startswith('00:'):
                print_fail(f"First cue start doesn't start with '00:': {first_cue_start}")
                return False
            print_pass(f"First surviving cue start is valid: {first_cue_start}")
        
        print_pass("TEST 2d PASSED - offset=130 drops early cues")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2e_subtitle_offset_absurd(file_id):
    """Test 2e: GET /api/subtitles/download with offset=99999999 (absurd)"""
    print_test("2e", "Subtitle download with offset=99999999 (absurd)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=99999999"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        print_pass("Returns 200 (no 500 error)")
        
        body = resp.text
        
        # Should still be valid WEBVTT
        if not body.startswith('WEBVTT'):
            print_fail(f"Body doesn't start with 'WEBVTT': {body[:100]}")
            return False
        print_pass("Body is valid WEBVTT structure")
        
        # Cue count should be 0 or very few
        cue_count = len(re.findall(r' --> ', body))
        print_info(f"Cue count: {cue_count}")
        if cue_count > 10:
            print_fail(f"Cue count {cue_count} > 10 (expected 0 or very few)")
            return False
        print_pass(f"Cue count {cue_count} is 0 or very few")
        
        print_pass("TEST 2e PASSED - Absurd offset handled gracefully")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2f_subtitle_offset_nan(file_id, baseline_count):
    """Test 2f: GET /api/subtitles/download with offset=abc (NaN)"""
    print_test("2f", "Subtitle download with offset=abc (NaN)")
    
    try:
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=abc"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        body = resp.text
        cue_count = len(re.findall(r' --> ', body))
        
        # Should be identical to baseline (treated as 0)
        if cue_count != baseline_count:
            print_fail(f"Cue count {cue_count} != baseline {baseline_count}")
            return False
        print_pass(f"Cue count === baseline ({cue_count}) (NaN treated as 0)")
        
        print_pass("TEST 2f PASSED - NaN offset treated as 0")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2g_subtitle_cache_offset_aware(file_id):
    """Test 2g: Verify cache is offset-aware"""
    print_test("2g", "Subtitle cache is offset-aware")
    
    try:
        # Hit offset=60 twice
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=60"
        
        # First hit
        print(f"First hit: GET {url}")
        start_time = time.time()
        resp1 = requests.get(url, timeout=TIMEOUT_SHORT)
        elapsed1 = time.time() - start_time
        print(f"First hit elapsed: {elapsed1:.3f}s")
        
        if resp1.status_code != 200:
            print_fail(f"First hit failed: {resp1.status_code}")
            return False
        
        # Second hit (should be cached)
        print(f"Second hit: GET {url}")
        start_time = time.time()
        resp2 = requests.get(url, timeout=TIMEOUT_SHORT)
        elapsed2 = time.time() - start_time
        print(f"Second hit elapsed: {elapsed2:.3f}s")
        
        if resp2.status_code != 200:
            print_fail(f"Second hit failed: {resp2.status_code}")
            return False
        
        # Second hit should be much faster (< 0.1s)
        if elapsed2 > 0.1:
            print_fail(f"Second hit too slow: {elapsed2:.3f}s (expected < 0.1s)")
            return False
        print_pass(f"Second hit is fast: {elapsed2:.3f}s (< 0.1s) - cache HIT")
        
        print_pass("TEST 2g PASSED - Cache is offset-aware")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2h_subtitle_cache_base_reuse(file_id):
    """Test 2h: Cache miss → on-the-fly shift (base cache reuse)"""
    print_test("2h", "Cache miss → on-the-fly shift (base cache reuse)")
    
    try:
        # Hit a NEW offset like offset=240
        # Should be fast because base (offset=0) is already cached
        url = f"{BASE_URL}/api/subtitles/download?file_id={file_id}&offset=240"
        print(f"GET {url}")
        
        start_time = time.time()
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        elapsed = time.time() - start_time
        print(f"Elapsed: {elapsed:.3f}s")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        # Should be fast (~0.01-0.1s) because base is cached
        if elapsed > 0.5:
            print_fail(f"Too slow: {elapsed:.3f}s (expected < 0.5s)")
            return False
        print_pass(f"Fast response: {elapsed:.3f}s (base cache reused, shifted on-the-fly)")
        
        print_pass("TEST 2h PASSED - Base cache reuse working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

# ============================================================================
# REGRESSION CHECKS
# ============================================================================

def test_regression_progress():
    """Regression: GET /api/progress still works"""
    print_test("R1", "Regression - GET /api/progress")
    
    try:
        url = f"{BASE_URL}/api/progress?clientId=test-handoff"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        if 'items' not in data:
            print_fail(f"Response missing 'items' key: {data}")
            return False
        
        print_pass(f"Returns 200 with items: {len(data['items'])} items")
        print_pass("REGRESSION R1 PASSED - /api/progress still works")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_regression_subtitle_search():
    """Regression: GET /api/subtitles/search still works"""
    print_test("R2", "Regression - GET /api/subtitles/search")
    
    try:
        url = f"{BASE_URL}/api/subtitles/search?tmdb_id=550&type=movie&languages=en"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        # Check for 'results' key (actual format)
        if 'results' not in data:
            print_fail(f"Response missing 'results' key: {data}")
            return False
        
        results = data.get('results', [])
        print_pass(f"Returns 200 with {len(results)} results")
        print_pass("REGRESSION R2 PASSED - /api/subtitles/search still works")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_regression_hls_playlist():
    """Regression: HLS playlist endpoint still serves real ffmpeg session"""
    print_test("R3", "Regression - HLS playlist endpoint")
    
    try:
        # Trigger a resolver to get a streamUrl
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        if resp.status_code != 200:
            print_fail(f"Resolver failed: {resp.status_code}")
            return False
        
        data = resp.json()
        stream_url = data.get('streamUrl', '')
        if not stream_url:
            print_fail("No streamUrl in resolver response")
            return False
        
        # Now fetch the HLS playlist
        url = f"{BASE_URL}{stream_url}"
        print(f"GET {url}")
        print("Waiting up to 15s for ffmpeg session...")
        
        resp = requests.get(url, timeout=15)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        body = resp.text
        if not body.startswith('#EXTM3U'):
            print_fail(f"Body doesn't start with #EXTM3U: {body[:100]}")
            return False
        
        print_pass("Returns 200 with #EXTM3U content")
        print_pass("REGRESSION R3 PASSED - HLS playlist endpoint still works")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

# ============================================================================
# MAIN
# ============================================================================

def main():
    print("\n" + "="*80)
    print("§10 CONTINUE WATCHING RESUME BACKEND TESTS")
    print("="*80)
    
    results = {}
    
    # ========================================================================
    # TASK 1: Resume-via-ffmpeg-ss
    # ========================================================================
    print("\n" + "="*80)
    print("TASK 1: Resume-via-ffmpeg-ss — HLS sessions accept startOffset")
    print("="*80)
    
    results['1a'] = test_1a_resolver_no_start()
    results['1b'] = test_1b_resolver_with_start()
    results['1c'] = test_1c_resolver_negative_start()
    results['1d'] = test_1d_resolver_nan_start()
    results['1e'] = test_1e_resolver_over_24h_start()
    results['1f'] = test_1f_resolver_tv_regression()
    results['1g'] = test_1g_post_session_invalid_url()
    results['1h'] = test_1h_post_session_no_url()
    results['1i'] = test_1i_post_session_http_url()
    results['1j'] = test_1j_post_session_valid_url()
    results['1k'] = test_1k_post_session_negative_start()
    results['1l'] = test_1l_post_session_nan_start()
    results['1m'] = test_1m_post_session_over_24h_start()
    
    # ========================================================================
    # TASK 2: Subtitle cue-shift
    # ========================================================================
    print("\n" + "="*80)
    print("TASK 2: Subtitle cue-shift — /api/subtitles/download?offset=<seconds>")
    print("="*80)
    
    # Get valid file_id first
    file_id = get_valid_file_id()
    if not file_id:
        print_fail("Could not get valid file_id - skipping subtitle tests")
        results['2a'] = False
        results['2b'] = False
        results['2c'] = False
        results['2d'] = False
        results['2e'] = False
        results['2f'] = False
        results['2g'] = False
        results['2h'] = False
    else:
        # Test 2a: Baseline
        result = test_2a_subtitle_baseline(file_id)
        if isinstance(result, tuple):
            results['2a'] = result[0]
            baseline_count = result[1]
            baseline_first_cue = result[2]
        else:
            results['2a'] = result
            baseline_count = None
            baseline_first_cue = None
        
        # Test 2b: offset=0
        if baseline_count:
            results['2b'] = test_2b_subtitle_offset_zero(file_id, baseline_count)
        else:
            print_test("2b", "SKIPPED - Test 2a failed")
            results['2b'] = False
        
        # Test 2c: offset=60
        if baseline_count and baseline_first_cue:
            results['2c'] = test_2c_subtitle_offset_60(file_id, baseline_count, baseline_first_cue)
        else:
            print_test("2c", "SKIPPED - Test 2a failed")
            results['2c'] = False
        
        # Test 2d: offset=130
        if baseline_count:
            results['2d'] = test_2d_subtitle_offset_130(file_id, baseline_count)
        else:
            print_test("2d", "SKIPPED - Test 2a failed")
            results['2d'] = False
        
        # Test 2e: offset=absurd
        results['2e'] = test_2e_subtitle_offset_absurd(file_id)
        
        # Test 2f: offset=NaN
        if baseline_count:
            results['2f'] = test_2f_subtitle_offset_nan(file_id, baseline_count)
        else:
            print_test("2f", "SKIPPED - Test 2a failed")
            results['2f'] = False
        
        # Test 2g: Cache offset-aware
        results['2g'] = test_2g_subtitle_cache_offset_aware(file_id)
        
        # Test 2h: Cache base reuse
        results['2h'] = test_2h_subtitle_cache_base_reuse(file_id)
    
    # ========================================================================
    # REGRESSION CHECKS
    # ========================================================================
    print("\n" + "="*80)
    print("REGRESSION CHECKS")
    print("="*80)
    
    results['R1'] = test_regression_progress()
    results['R2'] = test_regression_subtitle_search()
    results['R3'] = test_regression_hls_playlist()
    
    # ========================================================================
    # SUMMARY
    # ========================================================================
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    # Group by task
    task1_tests = [k for k in results.keys() if k.startswith('1')]
    task2_tests = [k for k in results.keys() if k.startswith('2')]
    regression_tests = [k for k in results.keys() if k.startswith('R')]
    
    print("\nTASK 1: Resume-via-ffmpeg-ss")
    for test_id in task1_tests:
        status = "✅ PASS" if results[test_id] else "❌ FAIL"
        print(f"  Test {test_id}: {status}")
    
    print("\nTASK 2: Subtitle cue-shift")
    for test_id in task2_tests:
        status = "✅ PASS" if results[test_id] else "❌ FAIL"
        print(f"  Test {test_id}: {status}")
    
    print("\nREGRESSION CHECKS")
    for test_id in regression_tests:
        status = "✅ PASS" if results[test_id] else "❌ FAIL"
        print(f"  Test {test_id}: {status}")
    
    print("\n" + "="*80)
    print(f"TOTAL: {passed}/{total} tests passed")
    print("="*80)
    
    return 0 if passed == total else 1

if __name__ == '__main__':
    sys.exit(main())

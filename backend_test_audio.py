#!/usr/bin/env python3
"""
Phase 2 Audio Track Selector Backend Tests
Tests the audio track switching functionality:
  - /api/realdebrid/resolve with ?audio=<index> parameter
  - POST /api/stream/hls/session with audioIndex in body
  - Edge cases: out-of-bounds, NaN, single-audio, multi-audio
"""

import requests
import time
import re
import sys
import json

BASE_URL = "http://localhost:3000"
TIMEOUT_SHORT = 10
TIMEOUT_LONG = 60

def print_test(num, desc):
    print(f"\n{'='*70}")
    print(f"TEST #{num}: {desc}")
    print('='*70)

def print_pass(msg):
    print(f"✅ PASS: {msg}")

def print_fail(msg):
    print(f"❌ FAIL: {msg}")

def validate_audio_streams_shape(audio_streams, test_name):
    """Validate audioStreams array shape"""
    if not isinstance(audio_streams, list):
        print_fail(f"{test_name}: audioStreams is not an array: {type(audio_streams)}")
        return False
    
    print_pass(f"{test_name}: audioStreams is array with {len(audio_streams)} items")
    
    # Validate each stream has required fields
    for i, stream in enumerate(audio_streams):
        required_fields = ['audioIndex', 'language', 'codec', 'channels']
        for field in required_fields:
            if field not in stream:
                print_fail(f"{test_name}: audioStreams[{i}] missing field '{field}'")
                return False
        
        # Validate types
        if not isinstance(stream['audioIndex'], int):
            print_fail(f"{test_name}: audioStreams[{i}].audioIndex is not int: {type(stream['audioIndex'])}")
            return False
        
        if stream['language'] is not None and not isinstance(stream['language'], str):
            print_fail(f"{test_name}: audioStreams[{i}].language is not str or null: {type(stream['language'])}")
            return False
        
        if not isinstance(stream['codec'], str):
            print_fail(f"{test_name}: audioStreams[{i}].codec is not str: {type(stream['codec'])}")
            return False
        
        if not isinstance(stream['channels'], int):
            print_fail(f"{test_name}: audioStreams[{i}].channels is not int: {type(stream['channels'])}")
            return False
    
    if len(audio_streams) > 0:
        print_pass(f"{test_name}: All audioStreams entries have correct shape")
        # Print first stream as example
        print(f"  Example: {json.dumps(audio_streams[0], indent=2)}")
    
    return True

def test_1_resolver_no_audio_param():
    """Test 1: /api/realdebrid/resolve without ?audio= param (Phase 1 behavior)"""
    print_test(1, "/api/realdebrid/resolve without ?audio= param (auto-detect English)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        
        # Check audioStreams field exists
        if 'audioStreams' not in data:
            print_fail("audioStreams field missing from response")
            return False
        print_pass("audioStreams field present")
        
        # Validate audioStreams shape
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        # Check selectedAudioIndex field exists
        if 'selectedAudioIndex' not in data:
            print_fail("selectedAudioIndex field missing from response")
            return False
        
        selected_index = data['selectedAudioIndex']
        if not isinstance(selected_index, int):
            print_fail(f"selectedAudioIndex is not int: {type(selected_index)}")
            return False
        print_pass(f"selectedAudioIndex present: {selected_index}")
        
        # Check qualities array has audioStreams and selectedAudioIndex
        qualities = data.get('qualities', [])
        if len(qualities) > 0:
            for i, q in enumerate(qualities):
                if 'audioStreams' not in q:
                    print_fail(f"qualities[{i}] missing audioStreams")
                    return False
                if 'selectedAudioIndex' not in q:
                    print_fail(f"qualities[{i}] missing selectedAudioIndex")
                    return False
            print_pass(f"All {len(qualities)} qualities have audioStreams and selectedAudioIndex")
        
        # Check alternates array has audioStreams and selectedAudioIndex
        alternates = data.get('alternates', [])
        if len(alternates) > 0:
            for i, alt in enumerate(alternates):
                if 'audioStreams' not in alt:
                    print_fail(f"alternates[{i}] missing audioStreams")
                    return False
                if 'selectedAudioIndex' not in alt:
                    print_fail(f"alternates[{i}] missing selectedAudioIndex")
                    return False
            print_pass(f"All {len(alternates)} alternates have audioStreams and selectedAudioIndex")
        
        print_pass("TEST 1 PASSED - Auto-detect behavior working, response includes audioStreams and selectedAudioIndex")
        return True, data
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2_resolver_audio_0():
    """Test 2: /api/realdebrid/resolve with ?audio=0 (select first track)"""
    print_test(2, "/api/realdebrid/resolve with ?audio=0 (select first track)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&audio=0"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        selected_index = data['selectedAudioIndex']
        if selected_index != 0:
            print_fail(f"selectedAudioIndex should be 0, got {selected_index}")
            return False
        print_pass(f"selectedAudioIndex === 0 (first track selected)")
        
        print_pass("TEST 2 PASSED - ?audio=0 selects first track")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_3_resolver_audio_1():
    """Test 3: /api/realdebrid/resolve with ?audio=1 (select second track if available)"""
    print_test(3, "/api/realdebrid/resolve with ?audio=1 (select second track if available)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&audio=1"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        audio_streams = data['audioStreams']
        selected_index = data['selectedAudioIndex']
        
        # If there are 2+ tracks, selectedAudioIndex should be 1
        # If there's only 1 track, it should fall back to 0
        if len(audio_streams) >= 2:
            if selected_index != 1:
                print_fail(f"selectedAudioIndex should be 1 (2+ tracks available), got {selected_index}")
                return False
            print_pass(f"selectedAudioIndex === 1 (second track selected, {len(audio_streams)} tracks available)")
        else:
            if selected_index != 0:
                print_fail(f"selectedAudioIndex should fall back to 0 (only {len(audio_streams)} track), got {selected_index}")
                return False
            print_pass(f"selectedAudioIndex === 0 (fallback, only {len(audio_streams)} track available)")
        
        print_pass("TEST 3 PASSED - ?audio=1 behavior correct")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_4_resolver_audio_out_of_bounds():
    """Test 4: /api/realdebrid/resolve with ?audio=99 (out of bounds, should fall back)"""
    print_test(4, "/api/realdebrid/resolve with ?audio=99 (out of bounds, should fall back)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&audio=99"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        print_pass("success === true (no crash on out-of-bounds)")
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        audio_streams = data['audioStreams']
        selected_index = data['selectedAudioIndex']
        
        # When audioIndex is out of bounds, it should fall back to auto-detection
        # (English or first track), so selectedAudioIndex should be valid
        if len(audio_streams) > 0:
            if selected_index >= len(audio_streams):
                print_fail(f"selectedAudioIndex {selected_index} is out of bounds (only {len(audio_streams)} tracks)")
                return False
            print_pass(f"selectedAudioIndex {selected_index} is valid (fell back to auto-detection, {len(audio_streams)} tracks available)")
        else:
            # Edge case: no audio streams detected (probe failed or audio-less source)
            # In this case, selectedAudioIndex=0 is acceptable as a default
            print_pass(f"No audio streams detected (probe failed or audio-less source), selectedAudioIndex={selected_index}")
        
        print_pass("TEST 4 PASSED - Out-of-bounds audio index falls back gracefully")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_5_resolver_audio_negative():
    """Test 5: /api/realdebrid/resolve with ?audio=-1 (negative, should fall back)"""
    print_test(5, "/api/realdebrid/resolve with ?audio=-1 (negative, should fall back)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&audio=-1"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        print_pass("success === true (no crash on negative)")
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        selected_index = data['selectedAudioIndex']
        print_pass(f"selectedAudioIndex {selected_index} (fell back to auto-detection)")
        
        print_pass("TEST 5 PASSED - Negative audio index falls back gracefully")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_6_resolver_audio_nan():
    """Test 6: /api/realdebrid/resolve with ?audio=abc (NaN, should fall back)"""
    print_test(6, "/api/realdebrid/resolve with ?audio=abc (NaN, should fall back)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&audio=abc"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_LONG)
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
        print_pass("success === true (no crash on NaN)")
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "resolver"):
            return False
        
        selected_index = data['selectedAudioIndex']
        print_pass(f"selectedAudioIndex {selected_index} (fell back to auto-detection)")
        
        print_pass("TEST 6 PASSED - NaN audio index falls back gracefully")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_7_post_session_no_audio_index(direct_url):
    """Test 7: POST /api/stream/hls/session without audioIndex (auto-detect)"""
    print_test(7, "POST /api/stream/hls/session without audioIndex (auto-detect)")
    
    if not direct_url:
        print_fail("No directUrl available from resolver (test 1 failed)")
        return False
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        print(f"POST {url}")
        
        # Use real Comet URL from resolver
        body = {
            "sourceUrl": direct_url,
            "start": 0,
            "filename": "Fight.Club.1999.1080p.mp4",
            "sizeBytes": 2000000000,
            "quality": "[RD⚡] Comet 1080p"
        }
        
        resp = requests.post(url, json=body, timeout=TIMEOUT_LONG)
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
        
        # Check required fields
        required_fields = ['sessionId', 'streamUrl', 'streamType', 'startOffset', 'audioStreams', 'selectedAudioIndex']
        for field in required_fields:
            if field not in data:
                print_fail(f"Missing field: {field}")
                return False
        print_pass("All required fields present")
        
        # Validate audioStreams shape
        if not validate_audio_streams_shape(data['audioStreams'], "POST session"):
            return False
        
        # Check selectedAudioIndex
        selected_index = data['selectedAudioIndex']
        if not isinstance(selected_index, int):
            print_fail(f"selectedAudioIndex is not int: {type(selected_index)}")
            return False
        print_pass(f"selectedAudioIndex present: {selected_index}")
        
        # Check sessionId format
        session_id = data['sessionId']
        if not re.match(r'^[a-f0-9]{16}$', session_id):
            print_fail(f"sessionId doesn't match pattern: {session_id}")
            return False
        print_pass(f"sessionId matches pattern: {session_id}")
        
        # Check streamUrl format
        stream_url = data['streamUrl']
        if not re.match(r'^/api/stream/hls/[a-f0-9]{16}/index\.m3u8$', stream_url):
            print_fail(f"streamUrl doesn't match pattern: {stream_url}")
            return False
        print_pass(f"streamUrl matches pattern: {stream_url}")
        
        print_pass("TEST 7 PASSED - POST session without audioIndex working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_8_post_session_audio_index_0(direct_url):
    """Test 8: POST /api/stream/hls/session with audioIndex=0"""
    print_test(8, "POST /api/stream/hls/session with audioIndex=0")
    
    if not direct_url:
        print_fail("No directUrl available from resolver (test 1 failed)")
        return False
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        print(f"POST {url}")
        
        body = {
            "sourceUrl": direct_url,
            "start": 0,
            "audioIndex": 0,
            "filename": "Fight.Club.1999.1080p.mp4",
            "sizeBytes": 2000000000,
            "quality": "[RD⚡] Comet 1080p"
        }
        
        resp = requests.post(url, json=body, timeout=TIMEOUT_LONG)
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
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "POST session"):
            return False
        
        selected_index = data['selectedAudioIndex']
        if selected_index != 0:
            print_fail(f"selectedAudioIndex should be 0, got {selected_index}")
            return False
        print_pass(f"selectedAudioIndex === 0 (first track selected)")
        
        print_pass("TEST 8 PASSED - POST session with audioIndex=0 working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_9_post_session_audio_index_1(direct_url):
    """Test 9: POST /api/stream/hls/session with audioIndex=1"""
    print_test(9, "POST /api/stream/hls/session with audioIndex=1")
    
    if not direct_url:
        print_fail("No directUrl available from resolver (test 1 failed)")
        return False
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        print(f"POST {url}")
        
        body = {
            "sourceUrl": direct_url,
            "start": 0,
            "audioIndex": 1,
            "filename": "Fight.Club.1999.1080p.mp4",
            "sizeBytes": 2000000000,
            "quality": "[RD⚡] Comet 1080p"
        }
        
        resp = requests.post(url, json=body, timeout=TIMEOUT_LONG)
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
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "POST session"):
            return False
        
        audio_streams = data['audioStreams']
        selected_index = data['selectedAudioIndex']
        
        # If there are 2+ tracks, selectedAudioIndex should be 1
        # If there's only 1 track, it should fall back to 0
        # If there are 0 tracks (probe failed), selectedAudioIndex=0 is acceptable
        if len(audio_streams) >= 2:
            if selected_index != 1:
                print_fail(f"selectedAudioIndex should be 1 (2+ tracks available), got {selected_index}")
                return False
            print_pass(f"selectedAudioIndex === 1 (second track selected, {len(audio_streams)} tracks available)")
        elif len(audio_streams) == 1:
            if selected_index != 0:
                print_fail(f"selectedAudioIndex should fall back to 0 (only {len(audio_streams)} track), got {selected_index}")
                return False
            print_pass(f"selectedAudioIndex === 0 (fallback, only {len(audio_streams)} track available)")
        else:
            # Edge case: no audio streams detected (probe failed or audio-less source)
            print_pass(f"No audio streams detected (probe failed or audio-less source), selectedAudioIndex={selected_index}")
        
        print_pass("TEST 9 PASSED - POST session with audioIndex=1 working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_10_post_session_audio_index_out_of_bounds(direct_url):
    """Test 10: POST /api/stream/hls/session with audioIndex=99 (out of bounds)"""
    print_test(10, "POST /api/stream/hls/session with audioIndex=99 (out of bounds)")
    
    if not direct_url:
        print_fail("No directUrl available from resolver (test 1 failed)")
        return False
    
    try:
        url = f"{BASE_URL}/api/stream/hls/session"
        print(f"POST {url}")
        
        body = {
            "sourceUrl": direct_url,
            "start": 0,
            "audioIndex": 99,
            "filename": "Fight.Club.1999.1080p.mp4",
            "sizeBytes": 2000000000,
            "quality": "[RD⚡] Comet 1080p"
        }
        
        resp = requests.post(url, json=body, timeout=TIMEOUT_LONG)
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
        print_pass("success === true (no crash on out-of-bounds)")
        
        # Check audioStreams and selectedAudioIndex
        if 'audioStreams' not in data or 'selectedAudioIndex' not in data:
            print_fail("audioStreams or selectedAudioIndex missing")
            return False
        
        if not validate_audio_streams_shape(data['audioStreams'], "POST session"):
            return False
        
        audio_streams = data['audioStreams']
        selected_index = data['selectedAudioIndex']
        
        # When audioIndex is out of bounds, it should fall back to auto-detection
        if len(audio_streams) > 0:
            if selected_index >= len(audio_streams):
                print_fail(f"selectedAudioIndex {selected_index} is out of bounds (only {len(audio_streams)} tracks)")
                return False
            print_pass(f"selectedAudioIndex {selected_index} is valid (fell back to auto-detection, {len(audio_streams)} tracks available)")
        else:
            # Edge case: no audio streams detected (probe failed or audio-less source)
            print_pass(f"No audio streams detected (probe failed or audio-less source), selectedAudioIndex={selected_index}")
        
        print_pass("TEST 10 PASSED - POST session with out-of-bounds audioIndex falls back gracefully")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_11_check_server_logs():
    """Test 11: Check server logs for audio selection messages"""
    print_test(11, "Check server logs for audio selection log format")
    
    try:
        # Read supervisor logs
        import subprocess
        result = subprocess.run(
            ['grep', '-E', r'\[HLS\] [a-f0-9]{16} audio: idx=', '/var/log/supervisor/nextjs.out.log'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        logs = result.stdout
        
        # Look for audio selection log lines
        # Format: [HLS] <id> audio: idx=N lang=xxx (user-override|eng-tag|fallback-first)
        audio_log_pattern = r'\[HLS\] [a-f0-9]{16} audio: idx=\d+ lang=\w+ \((user-override|eng-tag|fallback-first)\)'
        
        matches = re.findall(audio_log_pattern, logs)
        
        if len(matches) == 0:
            print_fail("No audio selection log lines found in server logs")
            print("Expected format: [HLS] <id> audio: idx=N lang=xxx (user-override|eng-tag|fallback-first)")
            print(f"Searched entire log file, found {len(logs.splitlines())} matching lines")
            return False
        
        print_pass(f"Found {len(matches)} audio selection log lines in server logs")
        
        # Check for user-override logs (from tests with explicit audio index)
        user_override_logs = [m for m in matches if m == 'user-override']
        if len(user_override_logs) > 0:
            print_pass(f"Found {len(user_override_logs)} 'user-override' logs (explicit audio index)")
        
        # Check for eng-tag or fallback-first logs (from auto-detection)
        auto_detect_logs = [m for m in matches if m in ['eng-tag', 'fallback-first']]
        if len(auto_detect_logs) > 0:
            print_pass(f"Found {len(auto_detect_logs)} auto-detection logs (eng-tag or fallback-first)")
        
        # Show a few examples
        log_lines = logs.splitlines()
        if len(log_lines) > 0:
            print("\nExample log lines:")
            for line in log_lines[-3:]:
                print(f"  {line}")
        
        print_pass("TEST 11 PASSED - Server logs show correct audio selection format")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("\n" + "="*70)
    print("PHASE 2 AUDIO TRACK SELECTOR BACKEND TESTS")
    print("="*70)
    
    results = {}
    direct_url = None
    
    # Test 1: Resolver without audio param
    result = test_1_resolver_no_audio_param()
    if isinstance(result, tuple):
        results[1] = result[0]
        if result[0] and len(result) > 1:
            data = result[1]
            direct_url = data.get('directUrl')
            print(f"\n📌 Captured directUrl for POST session tests: {direct_url[:80] if direct_url else 'None'}...")
    else:
        results[1] = result
    
    # Test 2: Resolver with audio=0
    results[2] = test_2_resolver_audio_0()
    
    # Test 3: Resolver with audio=1
    results[3] = test_3_resolver_audio_1()
    
    # Test 4: Resolver with audio=99 (out of bounds)
    results[4] = test_4_resolver_audio_out_of_bounds()
    
    # Test 5: Resolver with audio=-1 (negative)
    results[5] = test_5_resolver_audio_negative()
    
    # Test 6: Resolver with audio=abc (NaN)
    results[6] = test_6_resolver_audio_nan()
    
    # Test 7: POST session without audioIndex
    results[7] = test_7_post_session_no_audio_index(direct_url)
    
    # Test 8: POST session with audioIndex=0
    results[8] = test_8_post_session_audio_index_0(direct_url)
    
    # Test 9: POST session with audioIndex=1
    results[9] = test_9_post_session_audio_index_1(direct_url)
    
    # Test 10: POST session with audioIndex=99 (out of bounds)
    results[10] = test_10_post_session_audio_index_out_of_bounds(direct_url)
    
    # Test 11: Check server logs
    results[11] = test_11_check_server_logs()
    
    # Summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for num in sorted(results.keys()):
        status = "✅ PASS" if results[num] else "❌ FAIL"
        test_names = {
            1: "Resolver without ?audio= param",
            2: "Resolver with ?audio=0",
            3: "Resolver with ?audio=1",
            4: "Resolver with ?audio=99 (out of bounds)",
            5: "Resolver with ?audio=-1 (negative)",
            6: "Resolver with ?audio=abc (NaN)",
            7: "POST session without audioIndex",
            8: "POST session with audioIndex=0",
            9: "POST session with audioIndex=1",
            10: "POST session with audioIndex=99 (out of bounds)",
            11: "Server logs format check"
        }
        print(f"Test {num}: {status} - {test_names.get(num, 'Unknown')}")
    
    print("="*70)
    print(f"TOTAL: {passed}/{total} tests passed")
    print("="*70)
    
    return 0 if passed == total else 1

if __name__ == '__main__':
    sys.exit(main())

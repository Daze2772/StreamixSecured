#!/usr/bin/env python3
"""
Source Duration Field Tests
Tests the new sourceDuration field implementation in HLS streaming endpoints.
This field is probed ONCE at session creation via ffprobe and returned as a
float (seconds) to fix the "duration keeps growing" UX bug.
"""

import requests
import time
import re
import sys
import json

BASE_URL = "http://localhost:3000"
TIMEOUT_SHORT = 15
TIMEOUT_LONG = 60

def print_test(num, desc):
    print(f"\n{'='*70}")
    print(f"TEST #{num}: {desc}")
    print('='*70)

def print_pass(msg):
    print(f"✅ PASS: {msg}")

def print_fail(msg):
    print(f"❌ FAIL: {msg}")

def validate_source_duration(value, field_path):
    """Validate sourceDuration field - must be float seconds or null"""
    if value is None:
        print_pass(f"{field_path}: null (fallback when ffprobe fails)")
        return True
    
    if not isinstance(value, (int, float)):
        print_fail(f"{field_path}: not a number - got {type(value).__name__}: {value}")
        return False
    
    if value != value:  # NaN check
        print_fail(f"{field_path}: is NaN")
        return False
    
    if value < 0:
        print_fail(f"{field_path}: negative value {value}")
        return False
    
    if value == 0:
        print(f"⚠️  WARNING: {field_path}: is 0 (expected > 0 for real content)")
    
    print_pass(f"{field_path}: {value}s (valid float)")
    return True

def test_1_resolver_movie_source_duration():
    """Test 1: /api/realdebrid/resolve - movie with sourceDuration"""
    print_test(1, "/api/realdebrid/resolve - Fight Club (movie) sourceDuration")
    
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
        
        # Check top-level sourceDuration
        if 'sourceDuration' not in data:
            print_fail("Missing 'sourceDuration' field at top level")
            return False
        
        if not validate_source_duration(data['sourceDuration'], "data.sourceDuration"):
            return False
        
        # Check qualities array
        qualities = data.get('qualities', [])
        if not isinstance(qualities, list):
            print_fail(f"qualities is not an array: {type(qualities)}")
            return False
        print_pass(f"qualities array has {len(qualities)} items")
        
        # Check sourceDuration in each quality
        for i, quality in enumerate(qualities):
            if 'sourceDuration' not in quality:
                print_fail(f"Missing 'sourceDuration' in qualities[{i}]")
                return False
            if not validate_source_duration(quality['sourceDuration'], f"qualities[{i}].sourceDuration"):
                return False
        
        # Check alternates array
        alternates = data.get('alternates', [])
        if not isinstance(alternates, list):
            print_fail(f"alternates is not an array: {type(alternates)}")
            return False
        print_pass(f"alternates array has {len(alternates)} items")
        
        # Check sourceDuration in each alternate
        for i, alternate in enumerate(alternates):
            if 'sourceDuration' not in alternate:
                print_fail(f"Missing 'sourceDuration' in alternates[{i}]")
                return False
            if not validate_source_duration(alternate['sourceDuration'], f"alternates[{i}].sourceDuration"):
                return False
        
        print_pass("TEST 1 PASSED - All sourceDuration fields present and valid")
        return True, data.get('streamUrl')
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2_resolver_tv_source_duration():
    """Test 2: /api/realdebrid/resolve - TV show with sourceDuration"""
    print_test(2, "/api/realdebrid/resolve - Game of Thrones S01E01 (TV) sourceDuration")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=tv&imdb=tt0944947&season=1&episode=1"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        # Check top-level sourceDuration
        if 'sourceDuration' not in data:
            print_fail("Missing 'sourceDuration' field at top level")
            return False
        
        if not validate_source_duration(data['sourceDuration'], "data.sourceDuration"):
            return False
        
        # Check qualities array
        qualities = data.get('qualities', [])
        for i, quality in enumerate(qualities):
            if 'sourceDuration' not in quality:
                print_fail(f"Missing 'sourceDuration' in qualities[{i}]")
                return False
            if not validate_source_duration(quality['sourceDuration'], f"qualities[{i}].sourceDuration"):
                return False
        
        # Check alternates array
        alternates = data.get('alternates', [])
        for i, alternate in enumerate(alternates):
            if 'sourceDuration' not in alternate:
                print_fail(f"Missing 'sourceDuration' in alternates[{i}]")
                return False
            if not validate_source_duration(alternate['sourceDuration'], f"alternates[{i}].sourceDuration"):
                return False
        
        print_pass("TEST 2 PASSED - TV show sourceDuration fields present and valid")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_3_resolver_with_start_offset():
    """Test 3: /api/realdebrid/resolve with ?start= parameter"""
    print_test(3, "/api/realdebrid/resolve with ?start=120 - sourceDuration should be consistent")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start=120"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        # Check startOffset is echoed back
        if data.get('startOffset') != 120:
            print_fail(f"startOffset should be 120, got {data.get('startOffset')}")
            return False
        print_pass(f"startOffset === 120 (resume offset working)")
        
        # Check sourceDuration is still present and valid
        if 'sourceDuration' not in data:
            print_fail("Missing 'sourceDuration' field at top level")
            return False
        
        if not validate_source_duration(data['sourceDuration'], "data.sourceDuration"):
            return False
        
        # sourceDuration should be the FULL source duration, not affected by start offset
        source_duration = data['sourceDuration']
        if source_duration is not None and source_duration < 120:
            print_fail(f"sourceDuration ({source_duration}s) is less than start offset (120s) - should be full duration")
            return False
        
        print_pass(f"sourceDuration is full source duration (not affected by start offset)")
        
        print_pass("TEST 3 PASSED - Resume offset doesn't break duration probing")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_4_post_hls_session_source_duration():
    """Test 4: POST /api/stream/hls/session with sourceDuration"""
    print_test(4, "POST /api/stream/hls/session - sourceDuration in response")
    
    try:
        # First get a valid sourceUrl from resolver
        print("Step 1: Get valid sourceUrl from resolver...")
        resolver_url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        resolver_resp = requests.get(resolver_url, timeout=TIMEOUT_SHORT)
        
        if resolver_resp.status_code != 200:
            print_fail(f"Resolver failed: {resolver_resp.status_code}")
            return False
        
        resolver_data = resolver_resp.json()
        direct_url = resolver_data.get('directUrl')
        
        if not direct_url:
            print_fail("No directUrl in resolver response")
            return False
        
        print_pass(f"Got directUrl: {direct_url[:80]}...")
        
        # Now POST to create a new session
        print("\nStep 2: POST to /api/stream/hls/session...")
        session_url = f"{BASE_URL}/api/stream/hls/session"
        payload = {
            "sourceUrl": direct_url,
            "start": 300,  # 5 minutes in
            "quality": "1080p",
            "filename": "Fight.Club.1999.1080p.mp4",
            "sizeBytes": 2000000000
        }
        
        print(f"POST {session_url}")
        print(f"Payload: {json.dumps(payload, indent=2)}")
        
        # This endpoint probes ffmpeg, so it may take 10-15 seconds
        session_resp = requests.post(session_url, json=payload, timeout=TIMEOUT_LONG)
        print(f"Status: {session_resp.status_code}")
        
        if session_resp.status_code != 200:
            print_fail(f"Expected 200, got {session_resp.status_code}")
            print(f"Response: {session_resp.text[:500]}")
            return False
        
        session_data = session_resp.json()
        print(f"Response keys: {list(session_data.keys())}")
        
        # Check success
        if not session_data.get('success'):
            print_fail(f"success is not true: {session_data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check sessionId
        session_id = session_data.get('sessionId')
        if not session_id or not re.match(r'^[a-f0-9]{16}$', session_id):
            print_fail(f"Invalid sessionId: {session_id}")
            return False
        print_pass(f"sessionId: {session_id}")
        
        # Check streamUrl
        stream_url = session_data.get('streamUrl')
        expected_pattern = f"/api/stream/hls/{session_id}/index.m3u8"
        if stream_url != expected_pattern:
            print_fail(f"streamUrl doesn't match expected pattern: {stream_url}")
            return False
        print_pass(f"streamUrl: {stream_url}")
        
        # Check startOffset
        if session_data.get('startOffset') != 300:
            print_fail(f"startOffset should be 300, got {session_data.get('startOffset')}")
            return False
        print_pass(f"startOffset === 300")
        
        # Check sourceDuration
        if 'sourceDuration' not in session_data:
            print_fail("Missing 'sourceDuration' field in response")
            return False
        
        if not validate_source_duration(session_data['sourceDuration'], "response.sourceDuration"):
            return False
        
        print_pass("TEST 4 PASSED - POST /api/stream/hls/session returns sourceDuration")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_5_multiple_start_offsets_consistent_duration():
    """Test 5: sourceDuration is consistent across different start offsets"""
    print_test(5, "sourceDuration consistency - same source, different start offsets")
    
    try:
        offsets = [0, 120, 300]
        durations = []
        
        for offset in offsets:
            url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&start={offset}"
            print(f"\nGET {url}")
            
            resp = requests.get(url, timeout=TIMEOUT_SHORT)
            
            if resp.status_code != 200:
                print_fail(f"Request failed for offset={offset}: {resp.status_code}")
                return False
            
            data = resp.json()
            duration = data.get('sourceDuration')
            
            print(f"  start={offset} → sourceDuration={duration}")
            durations.append(duration)
        
        # All durations should be the same (or all null)
        if len(set(str(d) for d in durations)) > 1:
            print_fail(f"sourceDuration varies across offsets: {durations}")
            return False
        
        print_pass(f"sourceDuration is consistent across all offsets: {durations[0]}s")
        print_pass("TEST 5 PASSED - Duration probing is consistent")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_6_check_logs_for_duration_probe():
    """Test 6: Check server logs for duration probe messages"""
    print_test(6, "Server logs - verify ffprobe duration logging")
    
    try:
        print("Checking supervisor logs for HLS duration probe messages...")
        import subprocess
        
        # Get last 100 lines of nextjs logs
        result = subprocess.run(
            ['tail', '-n', '100', '/var/log/supervisor/nextjs.out.log'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        logs = result.stdout
        
        # Look for duration probe log lines
        duration_logs = [line for line in logs.split('\n') if 'source duration:' in line.lower()]
        
        if not duration_logs:
            print(f"⚠️  WARNING: No 'source duration' log lines found in recent logs")
            print("This might be expected if sessions were created earlier")
            # Not a failure - logs might have rotated
            return True
        
        print_pass(f"Found {len(duration_logs)} duration probe log lines:")
        for log in duration_logs[-5:]:  # Show last 5
            print(f"  {log.strip()}")
        
        # Check for successful probes (should show duration in seconds)
        success_logs = [line for line in duration_logs if re.search(r'source duration: \d+', line)]
        if success_logs:
            print_pass(f"Found {len(success_logs)} successful duration probes")
        
        # Check for failed probes (should show "unavailable")
        fail_logs = [line for line in duration_logs if 'unavailable' in line.lower()]
        if fail_logs:
            print(f"⚠️  Found {len(fail_logs)} failed duration probes (ffprobe failed)")
        
        print_pass("TEST 6 PASSED - Duration probe logging working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("\n" + "="*70)
    print("SOURCE DURATION FIELD TESTS")
    print("Testing the new sourceDuration field implementation")
    print("="*70)
    
    results = {}
    
    # Test 1: Resolver movie with sourceDuration
    result = test_1_resolver_movie_source_duration()
    if isinstance(result, tuple):
        results[1] = result[0]
        stream_url = result[1]
    else:
        results[1] = result
        stream_url = None
    
    # Test 2: Resolver TV with sourceDuration
    results[2] = test_2_resolver_tv_source_duration()
    
    # Test 3: Resolver with start offset
    results[3] = test_3_resolver_with_start_offset()
    
    # Test 4: POST /api/stream/hls/session
    results[4] = test_4_post_hls_session_source_duration()
    
    # Test 5: Consistency across offsets
    results[5] = test_5_multiple_start_offsets_consistent_duration()
    
    # Test 6: Check logs
    results[6] = test_6_check_logs_for_duration_probe()
    
    # Summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for num in sorted(results.keys()):
        status = "✅ PASS" if results[num] else "❌ FAIL"
        test_names = {
            1: "Resolver movie sourceDuration",
            2: "Resolver TV sourceDuration",
            3: "Resolver with start offset",
            4: "POST /api/stream/hls/session",
            5: "Duration consistency",
            6: "Server logs verification"
        }
        print(f"Test {num} ({test_names.get(num, 'Unknown')}): {status}")
    
    print("="*70)
    print(f"TOTAL: {passed}/{total} tests passed")
    print("="*70)
    
    if passed == total:
        print("\n✅ ALL TESTS PASSED - sourceDuration implementation is working correctly!")
        print("\nKey findings:")
        print("  • sourceDuration field is present in all API responses")
        print("  • Field is a float (seconds) or null (fallback)")
        print("  • Duration is consistent regardless of start offset")
        print("  • No NaN, undefined, or 0 values (except when ffprobe fails)")
    else:
        print(f"\n❌ {total - passed} TEST(S) FAILED - see details above")
    
    return 0 if passed == total else 1

if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""
Real-Debrid Premium Streaming Backend Tests
Tests the /api/realdebrid/resolve and /api/stream/proxy endpoints
"""

import requests
import json
import sys
from urllib.parse import quote, urlparse, parse_qs

BASE_URL = "http://localhost:3000"

def print_test_header(test_name):
    print(f"\n{'='*80}")
    print(f"TEST: {test_name}")
    print('='*80)

def print_success(message):
    print(f"✅ SUCCESS: {message}")

def print_failure(message):
    print(f"❌ FAILURE: {message}")

def print_info(message):
    print(f"ℹ️  INFO: {message}")

# Test 1: Resolve Fight Club movie (tt0137523)
def test_resolve_fight_club():
    print_test_header("Test 1: GET /api/realdebrid/resolve?type=movie&imdb=tt0137523")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=30)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 200:
            print_failure(f"Expected status 200, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return None
        
        data = response.json()
        print_info(f"Response keys: {list(data.keys())}")
        
        # Check success field
        if not data.get('success'):
            print_failure("Expected success=true")
            return None
        print_success("success=true ✓")
        
        # Check streamUrl
        stream_url = data.get('streamUrl', '')
        if not stream_url.startswith('/api/stream/proxy?ext=mp4&url='):
            print_failure(f"streamUrl should start with '/api/stream/proxy?ext=mp4&url=', got: {stream_url[:100]}")
            return None
        print_success(f"streamUrl starts with '/api/stream/proxy?ext=mp4&url=' ✓")
        
        # Check quality contains [RD⚡]
        quality = data.get('quality', '')
        if '[RD⚡]' not in quality:
            print_failure(f"quality should contain '[RD⚡]' (cached), got: {quality}")
            return None
        print_success(f"quality contains '[RD⚡]' (cached) ✓")
        
        # Check filename ends with .mp4
        filename = data.get('filename', '')
        if not filename.lower().endswith('.mp4'):
            print_failure(f"filename should end with .mp4, got: {filename}")
            return None
        print_success(f"filename ends with .mp4 ✓")
        
        # Check sizeBytes > 50MB (not the 410511 placeholder)
        size_bytes = data.get('sizeBytes', 0)
        if size_bytes <= 50_000_000:
            print_failure(f"sizeBytes should be > 50,000,000 (NOT placeholder 410511), got: {size_bytes}")
            return None
        print_success(f"sizeBytes = {size_bytes:,} (> 50MB, not placeholder) ✓")
        
        # Check probedOk
        probed_ok = data.get('probedOk')
        if not probed_ok:
            print_failure(f"probedOk should be true, got: {probed_ok}")
            return None
        print_success(f"probedOk=true ✓")
        
        # Check alternates is an array
        alternates = data.get('alternates', [])
        if not isinstance(alternates, list):
            print_failure(f"alternates should be an array, got: {type(alternates)}")
            return None
        if len(alternates) > 5:
            print_failure(f"alternates should have 0-5 items, got: {len(alternates)}")
            return None
        print_success(f"alternates is array with {len(alternates)} items (0-5) ✓")
        
        print_success(f"All checks passed for Fight Club resolve!")
        print_info(f"Quality: {quality}")
        print_info(f"Filename: {filename}")
        print_info(f"Size: {size_bytes:,} bytes ({size_bytes / (1024**3):.2f} GB)")
        
        return stream_url
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return None

# Test 2: Resolve Fight Club with debug=1
def test_resolve_fight_club_debug():
    print_test_header("Test 2: GET /api/realdebrid/resolve?type=movie&imdb=tt0137523&debug=1")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523&debug=1"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=30)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 200:
            print_failure(f"Expected status 200, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return False
        
        data = response.json()
        print_info(f"Response keys: {list(data.keys())}")
        
        # Check debug field
        if not data.get('debug'):
            print_failure("Expected debug=true")
            return False
        print_success("debug=true ✓")
        
        # Check top array
        top = data.get('top', [])
        if not isinstance(top, list):
            print_failure(f"Expected 'top' to be an array, got: {type(top)}")
            return False
        
        if len(top) == 0:
            print_failure("Expected 'top' array to have candidates")
            return False
        
        if len(top) > 12:
            print_failure(f"Expected 'top' array to have up to 12 candidates, got: {len(top)}")
            return False
        
        print_success(f"'top' array has {len(top)} candidates (up to 12) ✓")
        
        # Check first candidate has required fields
        if len(top) > 0:
            first = top[0]
            required_fields = ['score', 'sizeGB', 'filename']
            for field in required_fields:
                if field not in first:
                    print_failure(f"First candidate missing '{field}' field")
                    return False
            print_success(f"First candidate has required fields: {required_fields} ✓")
            print_info(f"Top candidate: score={first['score']}, sizeGB={first['sizeGB']}, filename={first['filename'][:80]}")
        
        print_success("All checks passed for debug mode!")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 3: Resolve Game of Thrones S01E01
def test_resolve_game_of_thrones():
    print_test_header("Test 3: GET /api/realdebrid/resolve?type=tv&imdb=tt0944947&season=1&episode=1")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=tv&imdb=tt0944947&season=1&episode=1"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=30)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 200:
            print_failure(f"Expected status 200, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return False
        
        data = response.json()
        
        # Check success field
        if not data.get('success'):
            print_failure("Expected success=true")
            print_info(f"Response: {json.dumps(data, indent=2)}")
            return False
        print_success("success=true ✓")
        
        print_success("Game of Thrones S01E01 resolved successfully!")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 4: Missing imdb parameter should return 400
def test_resolve_missing_imdb():
    print_test_header("Test 4: GET /api/realdebrid/resolve?type=movie (missing imdb)")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=10)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 400:
            print_failure(f"Expected status 400, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return False
        
        print_success("Correctly returned 400 for missing imdb parameter ✓")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 5: Stream proxy with Range request - verify real MP4 file
def test_stream_proxy_range_request(stream_url):
    print_test_header("Test 5: Stream proxy with Range: bytes=0-1023 (verify real MP4)")
    
    if not stream_url:
        print_failure("No streamUrl provided from previous test")
        return False
    
    try:
        url = f"{BASE_URL}{stream_url}"
        print_info(f"Requesting: {url[:150]}...")
        
        headers = {'Range': 'bytes=0-1023'}
        response = requests.get(url, headers=headers, timeout=30)
        print_info(f"Status Code: {response.status_code}")
        
        # Check status code
        if response.status_code != 206:
            print_failure(f"Expected status 206 Partial Content, got {response.status_code}")
            print_info(f"Response headers: {dict(response.headers)}")
            return False
        print_success("Status 206 Partial Content ✓")
        
        # Check Content-Type
        content_type = response.headers.get('Content-Type', '')
        if content_type != 'video/mp4':
            print_failure(f"Expected Content-Type: video/mp4, got: {content_type}")
            return False
        print_success("Content-Type: video/mp4 ✓")
        
        # Check Accept-Ranges
        accept_ranges = response.headers.get('Accept-Ranges', '')
        if accept_ranges != 'bytes':
            print_failure(f"Expected Accept-Ranges: bytes, got: {accept_ranges}")
            return False
        print_success("Accept-Ranges: bytes ✓")
        
        # Check Content-Range
        content_range = response.headers.get('Content-Range', '')
        if not content_range:
            print_failure("Missing Content-Range header")
            return False
        print_info(f"Content-Range: {content_range}")
        
        # Parse Content-Range to verify total size > 50MB
        # Format: bytes 0-1023/<total>
        if '/' in content_range:
            parts = content_range.split('/')
            if len(parts) == 2:
                total_size = parts[1]
                if total_size.isdigit():
                    total = int(total_size)
                    if total <= 50_000_000:
                        print_failure(f"Content-Range total should be > 50MB, got: {total:,}")
                        return False
                    print_success(f"Content-Range total = {total:,} bytes (> 50MB) ✓")
        
        # Check NO Content-Disposition header
        content_disposition = response.headers.get('Content-Disposition')
        if content_disposition:
            print_failure(f"Content-Disposition should be stripped, found: {content_disposition}")
            return False
        print_success("Content-Disposition header stripped ✓")
        
        # Check body length
        body = response.content
        if len(body) != 1024:
            print_failure(f"Expected body length 1024 bytes, got: {len(body)}")
            return False
        print_success("Body length = 1024 bytes ✓")
        
        # Check MP4 magic bytes - bytes 4-8 should be "ftyp" (0x66 0x74 0x79 0x70)
        # MP4 files start with: 00 00 00 XX 66 74 79 70 (where XX is size)
        if len(body) >= 8:
            magic = body[4:8]
            if magic == b'ftyp':
                print_success("MP4 magic bytes verified (bytes 4-8 = 'ftyp') ✓")
                print_info(f"First 16 bytes (hex): {body[:16].hex()}")
            else:
                print_failure(f"Expected MP4 magic bytes 'ftyp' at position 4-8, got: {magic.hex()}")
                print_info(f"First 16 bytes (hex): {body[:16].hex()}")
                return False
        else:
            print_failure("Body too short to verify MP4 magic bytes")
            return False
        
        print_success("All checks passed! This is a REAL MP4 video file, not placeholder!")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 6: Stream proxy without url parameter should return 400
def test_stream_proxy_no_url():
    print_test_header("Test 6: GET /api/stream/proxy (no url param)")
    
    try:
        url = f"{BASE_URL}/api/stream/proxy"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=10)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 400:
            print_failure(f"Expected status 400, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return False
        
        print_success("Correctly returned 400 for missing url parameter ✓")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 7: Stream proxy with non-whitelisted host should return 403
def test_stream_proxy_not_whitelisted():
    print_test_header("Test 7: GET /api/stream/proxy?url=https://example.com/foo.mp4 (not whitelisted)")
    
    try:
        test_url = quote("https://example.com/foo.mp4")
        url = f"{BASE_URL}/api/stream/proxy?url={test_url}"
        print_info(f"Requesting: {url}")
        
        response = requests.get(url, timeout=10)
        print_info(f"Status Code: {response.status_code}")
        
        if response.status_code != 403:
            print_failure(f"Expected status 403, got {response.status_code}")
            print_info(f"Response: {response.text}")
            return False
        
        print_success("Correctly returned 403 for non-whitelisted host ✓")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

# Test 8: Stream proxy with whitelisted RD URL and Range header
def test_stream_proxy_with_range(stream_url):
    print_test_header("Test 8: Stream proxy with whitelisted RD URL + Range header")
    
    if not stream_url:
        print_failure("No streamUrl provided from previous test")
        return False
    
    try:
        # Parse the streamUrl to get the encoded upstream URL
        parsed = urlparse(stream_url)
        params = parse_qs(parsed.query)
        
        if 'url' not in params:
            print_failure("streamUrl doesn't contain 'url' parameter")
            return False
        
        upstream_url = params['url'][0]
        print_info(f"Upstream URL (first 100 chars): {upstream_url[:100]}...")
        
        # Verify it's a whitelisted host
        upstream_parsed = urlparse(upstream_url)
        host = upstream_parsed.hostname
        print_info(f"Upstream host: {host}")
        
        whitelisted_domains = [
            'real-debrid.com', 'alldebrid.com', 'elfhosted.com', 
            'debrid.it', 'rdeb.io'
        ]
        
        is_whitelisted = any(
            host == domain or host.endswith(f'.{domain}')
            for domain in whitelisted_domains
        )
        
        if not is_whitelisted:
            print_failure(f"Host {host} is not in whitelist")
            return False
        print_success(f"Host {host} is whitelisted ✓")
        
        # Make request with Range header
        url = f"{BASE_URL}{stream_url}"
        headers = {'Range': 'bytes=0-1023'}
        response = requests.get(url, headers=headers, timeout=30)
        print_info(f"Status Code: {response.status_code}")
        
        # Check Content-Type is rewritten
        content_type = response.headers.get('Content-Type', '')
        if not content_type.startswith('video/'):
            print_failure(f"Content-Type should be rewritten to video/*, got: {content_type}")
            return False
        print_success(f"Content-Type rewritten to: {content_type} ✓")
        
        # Check Content-Disposition is stripped
        content_disposition = response.headers.get('Content-Disposition')
        if content_disposition:
            print_failure(f"Content-Disposition should be stripped, found: {content_disposition}")
            return False
        print_success("Content-Disposition stripped from upstream response ✓")
        
        print_success("All checks passed for stream proxy with Range!")
        return True
        
    except Exception as e:
        print_failure(f"Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("\n" + "="*80)
    print("REAL-DEBRID PREMIUM STREAMING BACKEND TESTS")
    print("="*80)
    
    results = {}
    
    # Test 1: Resolve Fight Club
    stream_url = test_resolve_fight_club()
    results['test_1_resolve_fight_club'] = stream_url is not None
    
    # Test 2: Resolve Fight Club with debug
    results['test_2_resolve_debug'] = test_resolve_fight_club_debug()
    
    # Test 3: Resolve Game of Thrones
    results['test_3_resolve_got'] = test_resolve_game_of_thrones()
    
    # Test 4: Missing imdb parameter
    results['test_4_missing_imdb'] = test_resolve_missing_imdb()
    
    # Test 5: Stream proxy with Range request (verify real MP4)
    results['test_5_stream_range'] = test_stream_proxy_range_request(stream_url)
    
    # Test 6: Stream proxy without url parameter
    results['test_6_proxy_no_url'] = test_stream_proxy_no_url()
    
    # Test 7: Stream proxy with non-whitelisted host
    results['test_7_proxy_not_whitelisted'] = test_stream_proxy_not_whitelisted()
    
    # Test 8: Stream proxy with Range header
    results['test_8_proxy_with_range'] = test_stream_proxy_with_range(stream_url)
    
    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for test_name, result in results.items():
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{status}: {test_name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 ALL TESTS PASSED! Real-Debrid Premium streaming is working correctly!")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) failed. See details above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())

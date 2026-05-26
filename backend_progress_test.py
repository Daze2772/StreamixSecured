#!/usr/bin/env python3
"""
Backend test for Continue Watching progress tracking API routes.
Tests POST, GET, GET single, and DELETE endpoints with various scenarios.
"""

import requests
import time
import json

# Base URL from environment
BASE_URL = "https://audio-track-selector.preview.emergentagent.com/api"

# Test data
CLIENT_ID = "test-client-progress-123"
MOVIE_TMDB_ID = 550  # Fight Club
TV_TMDB_ID = 1396  # Breaking Bad

def cleanup_test_data():
    """Clean up any existing test data before starting tests"""
    print("\n🧹 Cleaning up existing test data...")
    
    # Delete all movie progress
    try:
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "movie",
                "tmdbId": MOVIE_TMDB_ID
            },
            timeout=10
        )
        print(f"   Cleaned movie progress: {response.status_code}")
    except Exception as e:
        print(f"   Movie cleanup error (OK if none existed): {e}")
    
    # Delete all TV progress
    try:
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID
            },
            timeout=10
        )
        print(f"   Cleaned TV progress: {response.status_code}")
    except Exception as e:
        print(f"   TV cleanup error (OK if none existed): {e}")
    
    print("✅ Cleanup complete\n")

def test_post_movie_progress_incomplete():
    """Test 1: POST movie progress with position < 90% (incomplete)"""
    print("=" * 80)
    print("TEST 1: POST movie progress (incomplete - position < 90%)")
    print("=" * 80)
    
    try:
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "movie",
            "tmdbId": MOVIE_TMDB_ID,
            "position": 3000,  # 50 minutes
            "duration": 8280,  # 138 minutes (Fight Club runtime)
            "title": "Fight Club",
            "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
            "backdropPath": "/fCayJrkfRaCRCTh8GqN30f8oyQF.jpg"
        }
        
        response = requests.post(
            f"{BASE_URL}/progress",
            json=payload,
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        # Verify response
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        assert "item" in data, "Expected 'item' in response"
        
        item = data["item"]
        assert item["clientId"] == CLIENT_ID, "clientId mismatch"
        assert item["mediaType"] == "movie", "mediaType mismatch"
        assert item["tmdbId"] == MOVIE_TMDB_ID, "tmdbId mismatch"
        assert item["position"] == 3000, "position mismatch"
        assert item["duration"] == 8280, "duration mismatch"
        assert item["completed"] is False, f"Expected completed=false (position 3000/8280 = 36%), got {item['completed']}"
        assert item["title"] == "Fight Club", "title mismatch"
        
        print("✅ TEST 1 PASSED: Movie progress created with completed=false")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 1 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 1 ERROR: {e}")
        return False

def test_post_movie_progress_completed():
    """Test 2: POST movie progress with position >= 90% (completed)"""
    print("\n" + "=" * 80)
    print("TEST 2: POST movie progress (completed - position >= 90%)")
    print("=" * 80)
    
    try:
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "movie",
            "tmdbId": MOVIE_TMDB_ID,
            "position": 7500,  # 125 minutes (90.6% of 138 minutes)
            "duration": 8280,
            "title": "Fight Club",
            "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
            "backdropPath": "/fCayJrkfRaCRCTh8GqN30f8oyQF.jpg"
        }
        
        response = requests.post(
            f"{BASE_URL}/progress",
            json=payload,
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        # Verify response
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        
        item = data["item"]
        assert item["position"] == 7500, "position mismatch"
        assert item["completed"] is True, f"Expected completed=true (position 7500/8280 = 90.6%), got {item['completed']}"
        
        print("✅ TEST 2 PASSED: Movie progress updated with completed=true")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 2 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 2 ERROR: {e}")
        return False

def test_post_tv_episode_progress():
    """Test 3: POST TV episode progress and verify upsert works"""
    print("\n" + "=" * 80)
    print("TEST 3: POST TV episode progress (S1E1) and verify upsert")
    print("=" * 80)
    
    try:
        # First insert
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "tv",
            "tmdbId": TV_TMDB_ID,
            "season": 1,
            "episode": 1,
            "position": 1200,  # 20 minutes
            "duration": 3480,  # 58 minutes
            "title": "Breaking Bad",
            "episodeTitle": "Pilot",
            "posterPath": "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
            "backdropPath": "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg"
        }
        
        response = requests.post(
            f"{BASE_URL}/progress",
            json=payload,
            timeout=10
        )
        
        print(f"First insert - Status Code: {response.status_code}")
        data = response.json()
        print(f"First insert - Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        
        item = data["item"]
        assert item["season"] == 1, "season mismatch"
        assert item["episode"] == 1, "episode mismatch"
        assert item["position"] == 1200, "position mismatch"
        assert item["episodeTitle"] == "Pilot", "episodeTitle mismatch"
        
        print("✅ First insert successful")
        
        # Update same episode (upsert test)
        time.sleep(0.5)  # Small delay to ensure different updatedAt
        
        payload["position"] = 2400  # Update to 40 minutes
        
        response = requests.post(
            f"{BASE_URL}/progress",
            json=payload,
            timeout=10
        )
        
        print(f"\nUpsert - Status Code: {response.status_code}")
        data = response.json()
        print(f"Upsert - Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        item = data["item"]
        assert item["position"] == 2400, f"Expected position=2400 after upsert, got {item['position']}"
        assert item["season"] == 1, "season should still be 1"
        assert item["episode"] == 1, "episode should still be 1"
        
        print("✅ TEST 3 PASSED: TV episode progress created and upsert works (no duplicates)")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 3 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 3 ERROR: {e}")
        return False

def test_get_progress_tv_grouping():
    """Test 4: GET progress list with TV show grouping (one entry per show)"""
    print("\n" + "=" * 80)
    print("TEST 4: GET progress list - TV show grouping (one entry per show)")
    print("=" * 80)
    
    try:
        # Create progress for multiple episodes of same show
        episodes = [
            {"season": 1, "episode": 1, "position": 3000, "episodeTitle": "Pilot", "timestamp": 1},
            {"season": 1, "episode": 2, "position": 2000, "episodeTitle": "Cat's in the Bag...", "timestamp": 2},
            {"season": 1, "episode": 3, "position": 1500, "episodeTitle": "...And the Bag's in the River", "timestamp": 3},
        ]
        
        print("Creating progress for 3 episodes...")
        for ep in episodes:
            payload = {
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": ep["season"],
                "episode": ep["episode"],
                "position": ep["position"],
                "duration": 3480,
                "title": "Breaking Bad",
                "episodeTitle": ep["episodeTitle"],
                "posterPath": "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
                "backdropPath": "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg"
            }
            
            response = requests.post(f"{BASE_URL}/progress", json=payload, timeout=10)
            print(f"   Created S{ep['season']}E{ep['episode']}: {response.status_code}")
            time.sleep(0.2)  # Ensure different updatedAt timestamps
        
        # Now GET the progress list
        print("\nFetching progress list...")
        response = requests.get(
            f"{BASE_URL}/progress",
            params={"clientId": CLIENT_ID, "limit": 20},
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert "items" in data, "Expected 'items' in response"
        
        items = data["items"]
        
        # Filter for Breaking Bad entries
        bb_items = [item for item in items if item["tmdbId"] == TV_TMDB_ID]
        
        print(f"\nFound {len(bb_items)} Breaking Bad entries in progress list")
        
        # Should only have ONE entry for Breaking Bad (most recent episode)
        assert len(bb_items) == 1, f"Expected 1 Breaking Bad entry (grouped), got {len(bb_items)}"
        
        # Should be the most recent episode (S1E3)
        bb_item = bb_items[0]
        assert bb_item["season"] == 1, "Expected season 1"
        assert bb_item["episode"] == 3, f"Expected episode 3 (most recent), got episode {bb_item['episode']}"
        assert bb_item["episodeTitle"] == "...And the Bag's in the River", "Expected most recent episode title"
        
        print("✅ TEST 4 PASSED: TV show grouping works (only 1 entry per show, most recent episode)")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 4 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 4 ERROR: {e}")
        return False

def test_get_progress_filters():
    """Test 5: GET progress filters (position > 30, completed=false)"""
    print("\n" + "=" * 80)
    print("TEST 5: GET progress filters (position > 30, completed=false)")
    print("=" * 80)
    
    try:
        # Create entry with position=20 (should NOT appear in list)
        print("Creating entry with position=20 (should be filtered out)...")
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "movie",
            "tmdbId": 278,  # Shawshank Redemption
            "position": 20,  # Too low, should be filtered
            "duration": 8520,
            "title": "The Shawshank Redemption",
            "posterPath": "/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg"
        }
        
        response = requests.post(f"{BASE_URL}/progress", json=payload, timeout=10)
        print(f"   Created low-position entry: {response.status_code}")
        
        # Create entry with completed=true (should NOT appear in list)
        print("Creating entry with completed=true (should be filtered out)...")
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "movie",
            "tmdbId": 238,  # The Godfather
            "position": 10000,  # 90%+ of duration
            "duration": 10500,
            "title": "The Godfather",
            "posterPath": "/3bhkrj58Vtu7enYsRolD1fZdja1.jpg"
        }
        
        response = requests.post(f"{BASE_URL}/progress", json=payload, timeout=10)
        print(f"   Created completed entry: {response.status_code}")
        
        # Fetch progress list
        print("\nFetching progress list...")
        response = requests.get(
            f"{BASE_URL}/progress",
            params={"clientId": CLIENT_ID, "limit": 20},
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        
        items = data["items"]
        print(f"Total items returned: {len(items)}")
        
        # Check that low-position entry is NOT in list
        low_pos_items = [item for item in items if item["tmdbId"] == 278]
        assert len(low_pos_items) == 0, f"Expected 0 Shawshank entries (position=20 < 30), got {len(low_pos_items)}"
        print("✅ position > 30 filter working (Shawshank not in list)")
        
        # Check that completed entry is NOT in list
        completed_items = [item for item in items if item["tmdbId"] == 238]
        assert len(completed_items) == 0, f"Expected 0 Godfather entries (completed=true), got {len(completed_items)}"
        print("✅ completed=false filter working (Godfather not in list)")
        
        # Verify Breaking Bad IS in list (position=1500 > 30, completed=false)
        bb_items = [item for item in items if item["tmdbId"] == TV_TMDB_ID]
        assert len(bb_items) == 1, f"Expected 1 Breaking Bad entry, got {len(bb_items)}"
        print("✅ Breaking Bad in list (position > 30, completed=false)")
        
        print("✅ TEST 5 PASSED: Filters working correctly (position > 30, completed=false)")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 5 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 5 ERROR: {e}")
        return False

def test_get_single_progress():
    """Test 6: GET single progress entry"""
    print("\n" + "=" * 80)
    print("TEST 6: GET single progress entry")
    print("=" * 80)
    
    try:
        # Get specific TV episode (S1E3 from previous test)
        print("Fetching Breaking Bad S1E3 progress...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": 1,
                "episode": 3
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert "item" in data, "Expected 'item' in response"
        
        item = data["item"]
        assert item is not None, "Expected item to be found"
        assert item["tmdbId"] == TV_TMDB_ID, "tmdbId mismatch"
        assert item["season"] == 1, "season mismatch"
        assert item["episode"] == 3, "episode mismatch"
        assert item["position"] == 1500, "position mismatch"
        
        print("✅ Found correct episode")
        
        # Try to get non-existent entry
        print("\nFetching non-existent entry (S5E10)...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": 5,
                "episode": 10
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data["item"] is None, f"Expected item=null for non-existent entry, got {data['item']}"
        
        print("✅ TEST 6 PASSED: GET single returns correct item or null")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 6 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 6 ERROR: {e}")
        return False

def test_delete_specific_episode():
    """Test 7: DELETE specific TV episode"""
    print("\n" + "=" * 80)
    print("TEST 7: DELETE specific TV episode (S1E1)")
    print("=" * 80)
    
    try:
        # Delete S1E1
        print("Deleting Breaking Bad S1E1...")
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": 1,
                "episode": 1
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        assert data.get("deletedCount") == 1, f"Expected deletedCount=1, got {data.get('deletedCount')}"
        
        print("✅ S1E1 deleted")
        
        # Verify S1E1 is gone
        print("\nVerifying S1E1 is deleted...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": 1,
                "episode": 1
            },
            timeout=10
        )
        
        data = response.json()
        assert data["item"] is None, "Expected S1E1 to be deleted"
        print("✅ S1E1 confirmed deleted")
        
        # Verify S1E2 and S1E3 still exist
        print("\nVerifying S1E2 still exists...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID,
                "season": 1,
                "episode": 2
            },
            timeout=10
        )
        
        data = response.json()
        assert data["item"] is not None, "Expected S1E2 to still exist"
        print("✅ S1E2 still exists (only S1E1 was deleted)")
        
        print("✅ TEST 7 PASSED: DELETE specific episode works correctly")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 7 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 7 ERROR: {e}")
        return False

def test_delete_entire_show():
    """Test 8: DELETE entire TV show (all episodes)"""
    print("\n" + "=" * 80)
    print("TEST 8: DELETE entire TV show (no season/episode specified)")
    print("=" * 80)
    
    try:
        # Delete entire Breaking Bad show
        print("Deleting entire Breaking Bad show...")
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "tv",
                "tmdbId": TV_TMDB_ID
                # No season/episode = delete all
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        # Should delete S1E2 and S1E3 (S1E1 was already deleted in previous test)
        assert data.get("deletedCount") >= 2, f"Expected deletedCount >= 2, got {data.get('deletedCount')}"
        
        print(f"✅ Deleted {data.get('deletedCount')} episodes")
        
        # Verify all episodes are gone
        print("\nVerifying all episodes are deleted...")
        for ep in [2, 3]:
            response = requests.get(
                f"{BASE_URL}/progress/single",
                params={
                    "clientId": CLIENT_ID,
                    "mediaType": "tv",
                    "tmdbId": TV_TMDB_ID,
                    "season": 1,
                    "episode": ep
                },
                timeout=10
            )
            
            data = response.json()
            assert data["item"] is None, f"Expected S1E{ep} to be deleted"
            print(f"✅ S1E{ep} confirmed deleted")
        
        print("✅ TEST 8 PASSED: DELETE entire show works correctly")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 8 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 8 ERROR: {e}")
        return False

def test_delete_movie():
    """Test 9: DELETE movie entry"""
    print("\n" + "=" * 80)
    print("TEST 9: DELETE movie entry")
    print("=" * 80)
    
    try:
        # First create a movie entry
        print("Creating Fight Club progress...")
        payload = {
            "clientId": CLIENT_ID,
            "mediaType": "movie",
            "tmdbId": MOVIE_TMDB_ID,
            "position": 3000,
            "duration": 8280,
            "title": "Fight Club",
            "posterPath": "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg"
        }
        
        response = requests.post(f"{BASE_URL}/progress", json=payload, timeout=10)
        print(f"   Created: {response.status_code}")
        
        # Delete the movie
        print("\nDeleting Fight Club...")
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "movie",
                "tmdbId": MOVIE_TMDB_ID
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert data.get("success") is True, "Expected success=true"
        assert data.get("deletedCount") == 1, f"Expected deletedCount=1, got {data.get('deletedCount')}"
        
        print("✅ Movie deleted")
        
        # Verify movie is gone
        print("\nVerifying movie is deleted...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "mediaType": "movie",
                "tmdbId": MOVIE_TMDB_ID
            },
            timeout=10
        )
        
        data = response.json()
        assert data["item"] is None, "Expected movie to be deleted"
        print("✅ Movie confirmed deleted")
        
        print("✅ TEST 9 PASSED: DELETE movie works correctly")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 9 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 9 ERROR: {e}")
        return False

def test_error_handling():
    """Test 10: Error handling for missing parameters"""
    print("\n" + "=" * 80)
    print("TEST 10: Error handling for missing parameters")
    print("=" * 80)
    
    try:
        # POST without required fields
        print("Testing POST without clientId...")
        response = requests.post(
            f"{BASE_URL}/progress",
            json={
                "mediaType": "movie",
                "tmdbId": 550,
                "position": 1000,
                "duration": 8280
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        assert response.status_code == 400, f"Expected 400 for missing clientId, got {response.status_code}"
        print("✅ POST returns 400 for missing clientId")
        
        # GET without clientId
        print("\nTesting GET without clientId...")
        response = requests.get(f"{BASE_URL}/progress", timeout=10)
        
        print(f"Status Code: {response.status_code}")
        assert response.status_code == 400, f"Expected 400 for missing clientId, got {response.status_code}"
        print("✅ GET returns 400 for missing clientId")
        
        # GET single without required fields
        print("\nTesting GET single without mediaType...")
        response = requests.get(
            f"{BASE_URL}/progress/single",
            params={
                "clientId": CLIENT_ID,
                "tmdbId": 550
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        assert response.status_code == 400, f"Expected 400 for missing mediaType, got {response.status_code}"
        print("✅ GET single returns 400 for missing mediaType")
        
        # DELETE without required fields
        print("\nTesting DELETE without tmdbId...")
        response = requests.delete(
            f"{BASE_URL}/progress",
            json={
                "clientId": CLIENT_ID,
                "mediaType": "movie"
            },
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        assert response.status_code == 400, f"Expected 400 for missing tmdbId, got {response.status_code}"
        print("✅ DELETE returns 400 for missing tmdbId")
        
        print("✅ TEST 10 PASSED: Error handling works correctly")
        return True
        
    except AssertionError as e:
        print(f"❌ TEST 10 FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ TEST 10 ERROR: {e}")
        return False

def main():
    """Run all tests"""
    print("\n" + "=" * 80)
    print("CONTINUE WATCHING PROGRESS TRACKING API - BACKEND TESTS")
    print("=" * 80)
    print(f"Base URL: {BASE_URL}")
    print(f"Client ID: {CLIENT_ID}")
    print("=" * 80)
    
    # Cleanup before tests
    cleanup_test_data()
    
    # Run all tests
    results = []
    
    results.append(("POST movie progress (incomplete)", test_post_movie_progress_incomplete()))
    results.append(("POST movie progress (completed)", test_post_movie_progress_completed()))
    results.append(("POST TV episode + upsert", test_post_tv_episode_progress()))
    results.append(("GET progress - TV grouping", test_get_progress_tv_grouping()))
    results.append(("GET progress - filters", test_get_progress_filters()))
    results.append(("GET single progress", test_get_single_progress()))
    results.append(("DELETE specific episode", test_delete_specific_episode()))
    results.append(("DELETE entire show", test_delete_entire_show()))
    results.append(("DELETE movie", test_delete_movie()))
    results.append(("Error handling", test_error_handling()))
    
    # Summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{status}: {test_name}")
    
    print("=" * 80)
    print(f"TOTAL: {passed}/{total} tests passed")
    print("=" * 80)
    
    if passed == total:
        print("\n🎉 ALL TESTS PASSED! Continue Watching API is working correctly.")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) failed. Please review the output above.")
        return 1

if __name__ == "__main__":
    exit(main())

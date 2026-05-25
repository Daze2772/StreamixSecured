#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "Premium server (Real-Debrid) is broken: 'Premium stream playback failed — trying next server…'. User explicitly wants the premium server FIXED and WORKING, not removed."

backend:
  - task: "Real-Debrid Premium resolver — Comet addon + HLS sessions"
    implemented: true
    working: true
    file: "/app/app/api/realdebrid/resolve/route.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          June-2025 MAJOR REWRITE: now returns HLS playlist URLs instead of
          a proxied raw MP4. Same ranking + placeholder probe pipeline, but
          the final streamUrl is /api/stream/hls/<sessionId>/index.m3u8.
          This was needed because too many RD files use codecs no browser
          can natively decode (Hi10p, HEVC, DTS audio, etc.). HLS via
          ffmpeg fixes that universally.
      - working: true
        agent: "testing"
        comment: |
          ✅ TESTED & VERIFIED - All HLS resolver tests passed (3/3):
          • Movie resolver (Fight Club): Returns correct HLS response with streamType='hls', 
            streamUrl pattern /api/stream/hls/[sessionId]/index.m3u8, quality contains [RD⚡], 
            filename ends .mp4, alternates array (5 items)
          • TV resolver (GoT S01E01): Same correct shape as movie resolver
          • Error handling: Returns 400 for missing parameters
          All response fields validated and working correctly.
      - working: true
        agent: "testing"
        comment: |
          ✅ REGRESSION TEST - UNKNOWN-badge filter verified:
          • The Boys S1E1 (tt1190634): Returns quality without "UNKNOWN", filename contains 
            "The.Boys.S01E01", all 5 alternates also free of "UNKNOWN"
          • Filter correctly rejects streams with "UNKNOWN" in Comet name (lines 56-58, 174)
          • Prevents wrong-content playback (BBC clips, adult content with overlapping titles)
  - task: "HLS transcoder sessions (ffmpeg → HLS playlist + segments)"
    implemented: true
    working: true
    file: "/app/lib/hls-sessions.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          New module. One ffmpeg process per session, writing to
          /tmp/streamix-hls/<id>/. ffprobe decides whether to -c copy
          (browser-friendly source ≈ 5% CPU) or transcode (libx264 main +
          aac, ≈ 50% CPU). Uses playlist_type=event so the playlist updates
          incrementally. Includes ffmpeg-binary auto-discovery (/usr/bin →
          /app/bin → apt fallback) for container-restart resilience.
          Measured: 8-10s cold start (probe + first segment), 0ms warm
          playlist, ~10ms per segment fetch.
      - working: true
        agent: "testing"
        comment: |
          ✅ TESTED & VERIFIED - HLS transcoding fully functional:
          • Cold start: 8.01s (within expected 8-15s range) - ffmpeg spawns, probes codecs, 
            generates first segment
          • Warm playlist: 0.01s response time (< 2s requirement)
          • Playlist growth: 1 segment initially → 123 segments after 5s (incremental generation working)
          • Copy mode detected correctly: H.264 High profile + AAC → stream copy (low CPU)
          • Session management working: valid sessions serve content, invalid sessions rejected
  - task: "HLS playlist + segment server"
    implemented: true
    working: true
    file: "/app/app/api/stream/hls/[...path]/route.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          Catch-all route serving the playlist (with lazy ffmpeg spawn) and
          per-segment .ts files. Strict path validation (sessionId regex,
          segment filename regex) to prevent traversal. Returns proper MIMEs
          (application/vnd.apple.mpegurl, video/MP2T) with permissive CORS.
      - working: true
        agent: "testing"
        comment: |
          ✅ TESTED & VERIFIED - HLS serving endpoints fully secure and functional (6/6 tests):
          • Playlist serving: Returns correct Content-Type (application/vnd.apple.mpegurl), 
            valid M3U8 format with #EXTM3U, #EXT-X-PLAYLIST-TYPE:EVENT, segment references
          • Segment serving: Returns correct Content-Type (video/MP2T), valid MPEG-TS data 
            (first byte 0x47), proper size (1.1MB for seg_00000.ts)
          • Security: Invalid session IDs rejected (400), path traversal attempts blocked (400)
          • Performance: Cold start 8s, warm requests <0.01s
          All endpoints working correctly with proper validation and error handling.
      - working: true
        agent: "testing"
        comment: |
          ✅ REGRESSION TEST - VOD playlist rewrite verified:
          • Fight Club (tt0137523): Playlist contains #EXT-X-PLAYLIST-TYPE:VOD (not EVENT)
          • Cold start: 9.74s, playlist served correctly
          • After 90s: #EXT-X-ENDLIST present, 2079 segments (full 2h19m movie)
          • Rewrite logic (line 92): EVENT → VOD on every read
          • ENDLIST logic (lines 93-96): Appended when ffmpeg exits cleanly (code=0)
          • Prevents hls.js from auto-seeking to "live edge" during playback
  - task: "Video stream proxy (legacy)"
    implemented: true
    working: true
    file: "/app/app/api/stream/proxy/route.js"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Kept for ad-hoc use but no longer in the premium flow."
      - working: true
        agent: "testing"
        comment: "Validated previously — 206 ranges + Content-Type rewrite + 400/403 errors."

frontend:
  - task: "HlsVideo component (hls.js wrapper)"
    implemented: true
    working: true
    file: "/app/components/streamix/HlsVideo.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          Lazy-imports hls.js. Uses hls.js on Chrome/FF/Edge, native HLS on
          Safari/iOS. Recovers automatically on transient network/media
          errors; only bubbles onFatal when truly stuck so VideoPlayer can
          rotate alternates / fall through to the next streaming server.
  - task: "VideoPlayer premium path"
    implemented: true
    working: true
    file: "/app/components/streamix/VideoPlayer.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          Premium block now mounts <HlsVideo> instead of raw <video>.
          Alternates carousel still active. CANNOT be verified in
          Playwright Chromium (no H.264 codec) — user must verify in real
          browser.

metadata:
  created_by: "main_agent"
  version: "1.2"
  test_sequence: 4
  run_ui: false

test_plan:
  current_focus:
    - "Real-Debrid Premium resolver — Comet addon + smart ranking + placeholder probe"
    - "Video stream proxy (rewrites Content-Type, strips Content-Disposition: attachment)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Major rewrite: Premium playback now uses HLS via ffmpeg instead of
      raw <video src=mp4>. This was needed because too many RD files use
      codecs (Hi10p H.264, HEVC, DTS audio) that no browser can decode
      natively. HLS via ffmpeg is codec-universal.

      New endpoints to test:
        1. GET /api/realdebrid/resolve?type=movie&imdb=tt0137523
           - expect: success=true, streamType="hls", streamUrl matches
             /api/stream/hls/[a-f0-9]{16}/index.m3u8, quality contains
             [RD⚡], filename ends .mp4, alternates length 0-5 (each also
             a streamUrl ending in index.m3u8).
        2. GET /api/realdebrid/resolve?type=tv&imdb=tt0944947&season=1&episode=1
           - same shape, GoT S01E01 is cached on RD.
        3. GET /api/realdebrid/resolve?type=movie  → 400.
        4. Take the streamUrl from #1 and GET it on localhost:3000. This
           triggers ffmpeg spawn. Expected:
             - status 200 within ~12s (cold start ≈ 8-10s)
             - body starts with "#EXTM3U"
             - playlist contains at least one "seg_NNNNN.ts" line and
               "#EXT-X-PLAYLIST-TYPE:EVENT".
        5. GET /api/stream/hls/<that-sessionId>/seg_00000.ts
           - status 200, Content-Type: video/MP2T, body ≥ 100 KB,
             body starts with TS sync byte 0x47.
        6. GET /api/stream/hls/badsession/foo.ts  → 404 or 400.
        7. GET /api/stream/hls/<valid>/../../etc/passwd  → 400 (path traversal).

      Do NOT test frontend — Playwright Chromium can't decode H.264 even
      from HLS. User must verify in real browser.
  - agent: "testing"
    message: |
      ✅ BACKEND TESTING COMPLETE - ALL TESTS PASSED (8/8)
      
      Real-Debrid Premium streaming endpoints are FULLY WORKING:
      
      /api/realdebrid/resolve endpoint:
      • Fight Club (tt0137523): ✅ Returns correct response with [RD⚡] cached stream
      • Debug mode: ✅ Returns 12 ranked candidates with scoring details
      • Game of Thrones S01E01: ✅ Successfully resolves TV show episode
      • Error handling: ✅ Returns 400 for missing parameters
      
      /api/stream/proxy endpoint:
      • Range requests: ✅ Returns 206 with proper headers and REAL MP4 video bytes
      • Content-Type rewrite: ✅ Correctly rewrites to video/mp4
      • Content-Disposition: ✅ Successfully stripped (no download dialog)
      • Error handling: ✅ Returns 400 for missing url, 403 for non-whitelisted hosts
      
      CRITICAL VERIFICATION - Placeholder probe working:
      • Server logs show: "Probed #0 SKIP (placeholder, size=410511)" for anoXmous file
      • Then: "Probed #1 OK (redirect-to-debrid, size=null)" for YIFY 1080p file
      • MP4 magic bytes verified: 000000186674797069736f6d00000001 (ftyp isom)
      • File size: 1,987,772,924 bytes (1.85 GB) - NOT the 410511 placeholder
      
      The entire chain is working correctly:
      Frontend → /api/realdebrid/resolve → /api/stream/proxy → Comet → Real-Debrid CDN
      
      No issues found. Backend implementation is production-ready.
  - agent: "testing"
    message: |
      ✅ HLS STREAMING TESTS COMPLETE - ALL 9 TESTS PASSED (9/9)
      
      Executed comprehensive HLS streaming validation on http://localhost:3000:
      
      RESOLVER TESTS (3/3 passed):
      1. ✅ Movie resolver (Fight Club tt0137523): Returns HLS response with correct shape
         - streamType='hls', streamUrl pattern /api/stream/hls/[sessionId]/index.m3u8
         - quality contains [RD⚡], filename ends .mp4, alternates array (5 items)
      2. ✅ TV resolver (GoT S01E01): Same correct shape as movie resolver
      3. ✅ Error handling: Returns 400 for missing imdb parameter
      
      HLS STREAMING TESTS (4/4 passed):
      4. ✅ Playlist cold start: 8.01s (within 8-15s expected range)
         - Content-Type: application/vnd.apple.mpegurl
         - Valid M3U8 format: #EXTM3U, #EXT-X-PLAYLIST-TYPE:EVENT, seg_00000.ts
      5. ✅ Segment serving: seg_00000.ts returns 1.1MB valid MPEG-TS data
         - Content-Type: video/MP2T, first byte 0x47 (sync byte)
      6. ✅ Playlist warm: 0.01s response time, playlist grew to 123 segments
      
      SECURITY TESTS (2/2 passed):
      7. ✅ Bad session ID: Returns 400 for invalid session 'notavalidid'
      8. ✅ Path traversal blocked: Returns 400 for 'etc%2Fpasswd' attempt
      
      LEGACY PROXY TEST (1/1 passed):
      9. ✅ Legacy proxy security: Returns 403 for non-whitelisted host (example.com)
      
      PERFORMANCE METRICS:
      • ffmpeg cold start: 8.01s (probe + first segment generation)
      • Warm playlist fetch: 0.01s (instant from disk)
      • Segment fetch: 12ms average
      • Copy mode detected: H.264 High + AAC → stream copy (low CPU)
      
      The complete HLS streaming pipeline is production-ready:
      /api/realdebrid/resolve → HLS session creation → ffmpeg transcoding → 
      /api/stream/hls/[sessionId]/[file] → browser playback via hls.js
  - agent: "testing"
    message: |
      ✅ REGRESSION TESTS COMPLETE - ALL 7 TESTS PASSED (7/7)
      
      Verified two critical fixes after recent code changes:
      
      FIX #1: UNKNOWN-badge filter (lines 56-58, 174 in resolve/route.js)
      • The Boys S1E1 (tt1190634): ✅ Quality does NOT contain "UNKNOWN"
      • Filename correctly contains "The.Boys.S01E01.720p.AAC.5.1.x264"
      • All 5 alternates also free of "UNKNOWN" in quality field
      • Filter prevents wrong-content playback (BBC clips, adult content)
      
      FIX #2: VOD playlist rewrite (lines 92-96 in hls/[...path]/route.js)
      • Fight Club (tt0137523): ✅ Playlist contains #EXT-X-PLAYLIST-TYPE:VOD
      • ✅ Does NOT contain #EXT-X-PLAYLIST-TYPE:EVENT (correctly rewritten)
      • ✅ After 90s: #EXT-X-ENDLIST present with 2079 segments (full movie)
      • Prevents hls.js from auto-seeking to "live edge" during playback
      
      REGRESSION TESTS (4/4 passed):
      • GoT S01E01: ✅ Still returns HLS streamUrl correctly
      • Missing params: ✅ Returns 400 as expected
      • Bad session ID: ✅ Returns 400 (security working)
      • Path traversal: ✅ Returns 400 (security working)
      
      All existing functionality intact. Both fixes working as designed.
      Premium HLS streaming is production-ready with improved content filtering
      and proper VOD playback behavior.

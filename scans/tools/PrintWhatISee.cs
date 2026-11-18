// Print What I See: point the controller at a real object, pull the trigger, and the headset picks the
// object out of its own camera view (depth-continuity region growing on environment raycasts through the
// passthrough frame), flashes it in pixel by pixel, then shows it as voxels in place. Capture it from a few
// angles, press B, and the voxels go to storage for quest_print_object.py to mesh, slice and print.
//
// Right controller:  trigger = pick the object under the ray    grip = outline only / solid voxels
//                    B = save the object and start a new one    A = clear the current object
//                    thumbstick up/down = looser / tighter depth join (how far the selection may grow)
//                    thumbstick click = splat sensor on / off
//
// Scan (for a Gaussian splat and a print): from the first pick on (or from the start, with --ei printsee_record 1)
// the headset keeps a camera picture every few centimetres or degrees of head movement, whatever it looks at, with
// where the camera was and a grid of depth rays through the picture, in <object>/scan/ (see ScanLoop). A pick names
// the object to print: walk slowly all the way round it and the ring of dots round it turns green side by side.
// B saves; quest_scan.py on the PC pulls the folder and trains the splat; it makes the STL of the picked object
// that was walked round, or, if none was, a view of the surroundings from where they were photographed.
// Without controllers:
//   adb shell am start -n com.mersivity.printsee/com.unity3d.player.UnityPlayerGameActivity --ei printsee_scan 120
// picks whatever is in the middle of the view and saves after that many pictures or a full circle. The PC can ask
// for a save at any time by writing the file <app files>/save_now.
//
// Splat sensor: while it is on, the headset casts a grid of rays into its depth a few times a second and sends
// every hit to the PC (quest_splat.py, through adb reverse): where it is, which way the surface faces, the colour
// of the camera picture there and how much of the picture it covers. The PC keeps them as a map of splats, records
// them and shows them on 6ense.com. Started by hand (thumbstick click) or by the launch intent:
//   adb shell am start -n com.mersivity.printsee/com.unity3d.player.UnityPlayerGameActivity --ei printsee_splat 8791
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Meta.XR;
using Meta.XR.MRUtilityKit;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

public class PrintWhatISee : MonoBehaviour
{
    public PassthroughCameraAccess cameraAccess;
    public EnvironmentRaycastManager raycaster;
    public Transform rightController;
    public Material overlayMaterial;      // Unlit/Transparent, for the pixel-by-pixel flash
    public Material voxelMaterial;        // Standard with instancing on, for the voxels
    public Material rayMaterial;          // for the pointer line
    public float voxelSize = 0.015f;
    public int gridStep = 8;              // pixels between raycast nodes in the frame
    public int maxNodes = 3000;
    public float depthJoin = 0.03f;       // metres: neighbours closer than this in depth belong together
    public float maxObjectSize = 0.8f;    // metres: the selection never grows past this from the seed

    private struct Vox { public Color32 c; public int hits; }
    private readonly Dictionary<Vector3Int, Vox> _voxels = new();
    private Texture2D _frameTex, _overlayTex;
    private GameObject _overlayGO, _reticle, _hudGO;
    private LineRenderer _ray;
    private TextMesh _hud;
    private Transform _cam;
    private Mesh _cube;
    private readonly List<Matrix4x4[]> _batches = new();
    private readonly List<Vector4[]> _batchColors = new();
    private int _shownVoxels;
    private bool _outline, _busy, _cameraReady;
    private int _captures, _objectIndex = 1;
    private string _dir, _statusText = "starting", _objectStamp;
    // every change of the status line also goes to the log (adb logcat -s Unity), so a sitting can be followed from the PC
    private string _status
    {
        get => _statusText;
        set { if (value != _statusText) { _statusText = value; Debug.Log("[PrintSee] " + value); } }
    }
    private int _selfTest;                // > 0: pick this many times by itself at the middle of the camera view, then save
    // the splat sensor
    public int splatStep = 16;            // pixels between rays in the camera picture
    public int splatRaysPerFrame = 260;   // rays cast per rendered frame, so the headset keeps drawing smoothly
    private const int SplatDefaultPort = 8791;
    private int _splatPort;
    private volatile bool _splatOn;
    private volatile int _splatGen;       // goes up at every start, so a sender or a sweep left from an earlier start ends itself
    private Thread _splatThread;
    private readonly ConcurrentQueue<byte[]> _splatQueue = new();
    private long _splatSweeps, _splatHits;
    private volatile bool _splatLinked;
    private string _lastSaved;
    // the walk-around scan
    public int scanMaxPictures = 400;
    public float scanMinMove = 0.05f;     // metres of camera travel between pictures
    public float scanMinTurn = 6f;        // or degrees of turning
    public int scanDepthStep = 16;        // pixels between depth rays in a picture
    public int scanRaysPerFrame = 600;
    private const int ScanSides = 16;
    private bool _scanOn, _scanTooFast;
    private int _scanGen, _scanCount, _scanSidesSeen, _scanDepthHits;
    private string _scanDir;
    private Vector3 _scanSeed, _scanCentre;
    private float _scanRadius;
    private Pose _scanLastPose, _scanPrevPose;
    private double _scanPrevT;
    private StreamWriter _scanFrames;
    private bool _scanHasObject;                                  // a pick has named the object to walk round
    private readonly List<string> _scanPicks = new();             // every object picked, as it goes into scan.json
    private Color32[] _grabbed, _grabBuf, _pickBuf;               // the camera picture last read back (see Grab)
    private bool _grabBlocking, _grabbing;
    private int _grabFails;
    public int maxShownVoxels = 12000;                            // more than this are drawn thinned out
    private readonly int[] _scanSideCount = new int[ScanSides];
    private GameObject[] _scanRing;
    private Material _ringOff, _ringOn;
    private Texture2D _scanTex;
    private DateTime _saveSeen;
    private float _saveCheckT;
    private readonly List<string> _captureMeta = new();
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly int ColorId = Shader.PropertyToID("_Color");

    private IEnumerator Start()
    {
        Application.targetFrameRate = 72;
        Screen.sleepTimeout = SleepTimeout.NeverSleep;
        _dir = Path.Combine(Application.persistentDataPath, "objects");
        Directory.CreateDirectory(_dir);
        NewObject();
        if (!OVRPermissionsRequester.IsPermissionGranted(OVRPermissionsRequester.Permission.PassthroughCameraAccess)
            || !OVRPermissionsRequester.IsPermissionGranted(OVRPermissionsRequester.Permission.Scene))
        {
            _status = "asking for camera and room permission";
            OVRPermissionsRequester.Request(new[] { OVRPermissionsRequester.Permission.Scene, OVRPermissionsRequester.Permission.PassthroughCameraAccess });
        }
        while (!OVRPermissionsRequester.IsPermissionGranted(OVRPermissionsRequester.Permission.PassthroughCameraAccess)
               || !OVRPermissionsRequester.IsPermissionGranted(OVRPermissionsRequester.Permission.Scene))
        {
            _status = "waiting for the camera and room permissions: allow both in the dialog";
            yield return null;
        }
        if (!PassthroughCameraAccess.IsSupported) { _status = "this headset cannot share its cameras (Quest 3/3S on OS v74+)"; yield break; }
        if (!EnvironmentRaycastManager.IsSupported) { _status = "environment depth raycasts are not supported here"; yield break; }
        if (raycaster == null) raycaster = FindFirstObjectByType<EnvironmentRaycastManager>(FindObjectsInactive.Include);
        raycaster.enabled = true;
        cameraAccess.enabled = true;
        while (!cameraAccess.IsPlaying) { _status = "starting the camera"; yield return null; }
        var res = cameraAccess.CurrentResolution;
        _frameTex = new Texture2D(res.x, res.y, TextureFormat.RGBA32, false);
        _scanTex = new Texture2D(res.x, res.y, TextureFormat.RGBA32, false);
        _overlayTex = new Texture2D(res.x / gridStep, res.y / gridStep, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
        ClearOverlay();
        _cube = BuildCube();
        _cameraReady = true;
        var intr = cameraAccess.Intrinsics;
        Debug.Log($"[PrintSee] camera ready: {res.x} x {res.y}, focal {intr.FocalLength.x:F1} {intr.FocalLength.y:F1}, raycast supported {EnvironmentRaycastManager.IsSupported}, files in {_dir}");
        _status = "point at an object and pull the trigger";
        // hands-free check:  adb shell am start -n com.mersivity.printsee/com.unity3d.player.UnityPlayerGameActivity --ei printsee_selftest 2
        _selfTest = IntentInt("printsee_selftest");
        if (_selfTest > 0) StartCoroutine(SelfTest(_selfTest));
        int port = IntentInt("printsee_splat");
        if (port > 0) StartSplat(port);
        // a save request left from an earlier sitting does not count
        try { var p = SaveNowPath(); if (File.Exists(p)) { _saveSeen = File.GetLastWriteTimeUtc(p); File.Delete(p); } } catch { }
        int auto = IntentInt("printsee_scan");
        if (auto > 0 && _selfTest <= 0) StartCoroutine(AutoScan(auto));
        // --ei printsee_record 1: keep pictures from the start, before anything is picked
        else if (IntentInt("printsee_record") > 0 && _selfTest <= 0) StartRecording();
    }

    private static string SaveNowPath() => Path.Combine(Application.persistentDataPath, "save_now");

    // The PC asks for a save by writing <app files>/save_now (adb shell touch ...): the same as pressing B.
    private void CheckRemoteSave()
    {
        if (_busy || Time.unscaledTime - _saveCheckT < 0.5f) return;
        _saveCheckT = Time.unscaledTime;
        try
        {
            var p = SaveNowPath();
            if (!File.Exists(p)) return;
            var t = File.GetLastWriteTimeUtc(p);
            if (t == _saveSeen) return;
            _saveSeen = t;
            try { File.Delete(p); } catch { }
            Debug.Log("[PrintSee] save asked for from the PC");
            SaveObject();
        }
        catch (Exception e) { Debug.LogWarning("[PrintSee] save_now check failed: " + e.Message); }
    }

    // nine spots of the camera view, the middle first: the first one with depth behind it
    private bool TryFindDepth(out Ray ray, out float dist)
    {
        var pose = cameraAccess.GetCameraPose();
        foreach (var vp in new[] { new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.4f), new Vector2(0.4f, 0.5f), new Vector2(0.6f, 0.5f), new Vector2(0.5f, 0.6f),
                                   new Vector2(0.35f, 0.35f), new Vector2(0.65f, 0.35f), new Vector2(0.35f, 0.65f), new Vector2(0.65f, 0.65f) })
        {
            var r = cameraAccess.ViewportPointToRay(vp, pose);
            if (raycaster.Raycast(r, out var h, 5f) && h.status == EnvironmentRaycastHitStatus.Hit)
            {
                ray = r; dist = Vector3.Distance(pose.position, h.point); return true;
            }
        }
        ray = default; dist = 0f; return false;
    }

    // A scan without a hand on the controller: pick what is in the middle of the view, let the scan run while the
    // person walks round, save after `pictures` pictures or once every side has been seen.
    private IEnumerator AutoScan(int pictures)
    {
        Debug.Log($"[PrintSee] AUTOSCAN start: saving after {pictures} pictures or a full circle");
        yield return new WaitForSeconds(3f);
        Ray ray = default; float dist = 0f, waited = 0f; bool found = false;
        while (!found && waited < 120f)
        {
            found = TryFindDepth(out ray, out dist);
            if (!found) { _status = "scan: waiting for depth in front of the camera: look at the object"; yield return new WaitForSeconds(1f); waited += 1f; }
        }
        if (!found) { Debug.Log("[PrintSee] AUTOSCAN FAIL: no depth in the camera view after 120 s"); yield break; }
        Debug.Log($"[PrintSee] AUTOSCAN picking at {dist:F2} m");
        while (_busy) yield return null;
        yield return StartCoroutine(Pick(ray));
        if (!_scanOn || !_scanHasObject) { Debug.Log("[PrintSee] AUTOSCAN FAIL: the pick did not start a scan (" + _status + ")"); yield break; }
        while (_scanOn && _scanCount < pictures && !(_scanSidesSeen >= ScanSides && _scanCount >= 40)) yield return null;
        while (_busy) yield return null;
        if (_scanOn) SaveObject();
    }

    private static int IntentInt(string key)
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        try
        {
            using var up = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var act = up.GetStatic<AndroidJavaObject>("currentActivity");
            using var intent = act.Call<AndroidJavaObject>("getIntent");
            return intent.Call<int>("getIntExtra", key, 0);
        }
        catch (Exception e) { Debug.LogWarning("[PrintSee] could not read the launch intent: " + e.Message); }
#endif
        return 0;
    }

    // The whole chain without a hand on the controller: wait for depth, pick at the middle of the camera view
    // (or the nearest spot with depth around it), a few times, save, and say in the log what happened.
    private IEnumerator SelfTest(int picks)
    {
        Debug.Log($"[PrintSee] SELFTEST start: {picks} pick(s)");
        yield return new WaitForSeconds(3f);
        int done = 0, before = 0;
        for (int i = 0; i < picks; i++)
        {
            Ray? found = null; float waited = 0f;
            while (found == null && waited < 20f)
            {
                var pose = cameraAccess.GetCameraPose();
                foreach (var vp in new[] { new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.4f), new Vector2(0.4f, 0.5f), new Vector2(0.6f, 0.5f), new Vector2(0.5f, 0.6f),
                                           new Vector2(0.35f, 0.35f), new Vector2(0.65f, 0.35f), new Vector2(0.35f, 0.65f), new Vector2(0.65f, 0.65f) })
                {
                    var r = cameraAccess.ViewportPointToRay(vp, pose);
                    if (raycaster.Raycast(r, out var h, 5f) && h.status == EnvironmentRaycastHitStatus.Hit)
                    {
                        Debug.Log($"[PrintSee] SELFTEST depth at view ({vp.x:F2}, {vp.y:F2}): {Vector3.Distance(pose.position, h.point):F2} m");
                        found = r; break;
                    }
                }
                if (found == null) { _status = "self-test: waiting for depth in front of the camera"; yield return new WaitForSeconds(1f); waited += 1f; }
            }
            if (found == null) { Debug.Log("[PrintSee] SELFTEST FAIL: no depth anywhere in the camera view after 20 s"); _status = "self-test: no depth (is the room lit, is something within 5 m?)"; yield break; }
            while (_busy) yield return null;
            before = _voxels.Count;
            yield return StartCoroutine(Pick(found));
            Debug.Log($"[PrintSee] SELFTEST pick {i + 1}: voxels {before} -> {_voxels.Count}, captures {_captures}, status: {_status}");
            if (_voxels.Count > before) done++;
            yield return new WaitForSeconds(2.5f);
        }
        int n = _voxels.Count;
        SaveObject();
        Debug.Log($"[PrintSee] SELFTEST {(done > 0 && _lastSaved != null ? "PASS" : "FAIL")}: {done} of {picks} picks added voxels, {n} voxels saved as {_lastSaved}");
        _status = done > 0 ? $"self-test done: {n} voxels saved; trigger works as usual now" : "self-test: nothing was picked";
    }

    private void Update()
    {
        if (_cam == null) { var c = Camera.main; if (c != null) _cam = c.transform; }
        UpdatePointer();
        UpdateHud();
        DrawVoxels();
        if (!_cameraReady) return;
        if (OVRInput.GetDown(OVRInput.Button.PrimaryThumbstick, OVRInput.Controller.RTouch))
        {
            if (_splatOn) StopSplat(); else StartSplat(_splatPort > 0 ? _splatPort : SplatDefaultPort);
        }
        CheckRemoteSave();
        if (_busy) return;
        if (OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.RTouch)) StartCoroutine(Pick());
        if (OVRInput.GetDown(OVRInput.Button.PrimaryHandTrigger, OVRInput.Controller.RTouch)) { _outline = !_outline; RebuildBatches(); }
        if (OVRInput.GetDown(OVRInput.Button.Two, OVRInput.Controller.RTouch)) SaveObject();
        if (OVRInput.GetDown(OVRInput.Button.One, OVRInput.Controller.RTouch))
        {
            // forget the object and its voxels; the pictures taken so far stay
            _scanHasObject = false; _scanPicks.Clear(); _scanSidesSeen = 0; Array.Clear(_scanSideCount, 0, ScanSides); DestroyRing();
            _voxels.Clear(); _captures = 0; _captureMeta.Clear(); RebuildBatches(); _status = "cleared";
        }
        var stick = OVRInput.Get(OVRInput.Axis2D.PrimaryThumbstick, OVRInput.Controller.RTouch);
        if (Mathf.Abs(stick.y) > 0.6f) depthJoin = Mathf.Clamp(depthJoin + stick.y * 0.02f * Time.deltaTime, 0.01f, 0.15f);
    }

    // ---------------------------------------------------------------- the splat sensor
    private void StartSplat(int port)
    {
        if (_splatOn) return;
        _splatPort = port;
        _splatOn = true;
        _splatSweeps = 0; _splatHits = 0;
        int gen = _splatGen + 1;
        _splatGen = gen;
        while (_splatQueue.TryDequeue(out _)) { }                 // nothing stale from the last run
        _splatThread = new Thread(() => SplatSender(gen)) { IsBackground = true, Name = "splat-sender" };
        _splatThread.Start();
        StartCoroutine(SplatLoop(gen));
        Debug.Log($"[PrintSee] splat sensor ON: sending to the PC on port {port}");
        _status = "splat sensor on: look around slowly";
    }

    private void StopSplat()
    {
        if (!_splatOn) return;
        _splatOn = false;
        Debug.Log($"[PrintSee] splat sensor OFF after {_splatSweeps} sweeps, {_splatHits} hits");
        _status = "splat sensor off";
    }

    private void OnDestroy() { _splatOn = false; }

    // one thread owns the socket: it connects to the PC (127.0.0.1 on the headset is the PC's port through adb reverse),
    // sends what the sweeps queue, and keeps trying when the PC is not listening yet
    private void SplatSender(int gen)
    {
        TcpClient tcp = null; NetworkStream stream = null;
        bool Mine() => _splatOn && gen == _splatGen;              // false once the sensor is stopped or started again
        while (Mine())
        {
            try
            {
                if (tcp == null || !tcp.Connected)
                {
                    _splatLinked = false;
                    tcp?.Close();
                    tcp = new TcpClient { NoDelay = true, SendTimeout = 3000 };
                    tcp.Connect("127.0.0.1", _splatPort);
                    stream = tcp.GetStream();
                    if (Mine()) _splatLinked = true;
                }
                if (!Mine()) break;
                if (_splatQueue.TryDequeue(out var packet)) stream.Write(packet, 0, packet.Length);
                else Thread.Sleep(5);
            }
            catch (Exception)
            {
                if (Mine()) _splatLinked = false;
                try { tcp?.Close(); } catch { }
                tcp = null;
                Thread.Sleep(1000);
            }
        }
        try { tcp?.Close(); } catch { }
        if (gen == _splatGen) _splatLinked = false;
    }

    // One sweep: the colour of the picture at every node of a jittered grid, then a ray into the depth for each node,
    // a few hundred per frame. What hits goes out as one packet:
    //   "QSP1" | uint32 bytes | float64 t_unix_ms | float32 cam_pos[3] | cam_rot[4] | uint16 W, H | float32 focal | uint32 n |
    //   n x { float32 x, y, z | int8 normal x, y, z (x127) | uint8 r, g, b | uint16 radius in half-millimetres }
    private IEnumerator SplatLoop(int gen)
    {
        var rng = new System.Random(1);
        int W = _frameTex.width, H = _frameTex.height;
        int nx = W / splatStep, ny = H / splatStep;
        float focal = cameraAccess.Intrinsics.FocalLength.x;
        var cols = new Color32[nx * ny];
        long sweepsTried = 0;
        while (_splatOn && gen == _splatGen)
        {
            if (_busy) { yield return null; continue; }              // a pick is flashing: let it finish
            // the picture is read without stopping the frame (Grab), as the scan reads its own: the two can run together
            var camPose = cameraAccess.GetCameraPose();              // of the moment the picture is asked for
            yield return StartCoroutine(Grab());
            if (!_splatOn || gen != _splatGen) yield break;
            var colors = _grabbed;
            if (colors == null || colors.Length < W * H || _busy) { yield return null; continue; }
            float jx = (float)rng.NextDouble(), jy = (float)rng.NextDouble();
            for (int iy = 0; iy < ny; iy++)
                for (int ix = 0; ix < nx; ix++)
                {
                    int px = Mathf.Clamp((int)((ix + jx) * splatStep), 0, W - 1), py = Mathf.Clamp((int)((iy + jy) * splatStep), 0, H - 1);
                    cols[iy * nx + ix] = colors[py * W + px];
                }
            double tMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using var body = new MemoryStream(nx * ny * 20);
            using var w = new BinaryWriter(body);
            int n = 0, cast = 0;
            for (int iy = 0; iy < ny && _splatOn && gen == _splatGen; iy++)
                for (int ix = 0; ix < nx; ix++)
                {
                    var r = cameraAccess.ViewportPointToRay(new Vector2((ix + jx) / nx, (iy + jy) / ny), camPose);
                    if (raycaster.Raycast(r, out var h, 5f) && h.status == EnvironmentRaycastHitStatus.Hit)
                    {
                        float d = Vector3.Distance(camPose.position, h.point);
                        var c = cols[iy * nx + ix];
                        var nrm = h.normal == Vector3.zero ? -r.direction : h.normal;
                        w.Write(h.point.x); w.Write(h.point.y); w.Write(h.point.z);
                        w.Write((sbyte)Mathf.Clamp(Mathf.RoundToInt(nrm.x * 127f), -127, 127));
                        w.Write((sbyte)Mathf.Clamp(Mathf.RoundToInt(nrm.y * 127f), -127, 127));
                        w.Write((sbyte)Mathf.Clamp(Mathf.RoundToInt(nrm.z * 127f), -127, 127));
                        w.Write(c.r); w.Write(c.g); w.Write(c.b);
                        w.Write((ushort)Mathf.Clamp(d * splatStep / focal * 0.75f * 2000f, 4f, 65535f));
                        n++;
                    }
                    if (++cast % splatRaysPerFrame == 0) yield return null;
                }
            w.Flush();
            if (!_splatOn || gen != _splatGen) yield break;          // stopped part-way: the half sweep is dropped, the "off" line stays
            sweepsTried++;
            if (n > 0)
            {
                using var packet = new MemoryStream(64 + (int)body.Length);
                using var pw = new BinaryWriter(packet);
                pw.Write((byte)'Q'); pw.Write((byte)'S'); pw.Write((byte)'P'); pw.Write((byte)'1');
                pw.Write((uint)(8 + 12 + 16 + 4 + 4 + 4 + body.Length));
                pw.Write(tMs);
                pw.Write(camPose.position.x); pw.Write(camPose.position.y); pw.Write(camPose.position.z);
                pw.Write(camPose.rotation.x); pw.Write(camPose.rotation.y); pw.Write(camPose.rotation.z); pw.Write(camPose.rotation.w);
                pw.Write((ushort)W); pw.Write((ushort)H); pw.Write(focal); pw.Write((uint)n);
                pw.Write(body.GetBuffer(), 0, (int)body.Length);
                pw.Flush();
                while (_splatQueue.Count > 6) _splatQueue.TryDequeue(out _);          // the PC is behind: drop the oldest sweep
                _splatQueue.Enqueue(packet.ToArray());
                _splatSweeps++; _splatHits += n;
            }
            // the status line, without a log line per sweep
            _statusText = _splatLinked ? $"splat sensor: {_splatSweeps} sweeps, {_splatHits} hits sent to the PC"
                                       : $"splat sensor: waiting for the PC ({_splatSweeps} sweeps seen, not sent)";
            if (sweepsTried % 30 == 1) Debug.Log($"[PrintSee] splat sensor: {_splatSweeps} sweeps with hits of {sweepsTried}, {_splatHits} hits, last sweep {n} of {nx * ny} rays hit, PC linked {_splatLinked}");
            yield return null;
        }
    }

    // ---------------------------------------------------------------- picking
    private IEnumerator Pick(Ray? forced = null)
    {
        _busy = true;
        var t0 = Time.realtimeSinceStartupAsDouble;
        Ray ray;
        if (forced.HasValue) ray = forced.Value;
        else if (!TryControllerRay(out ray)) { _status = "no controller and no head pose yet"; _busy = false; yield break; }
        if (!raycaster.Raycast(ray, out var seedHit, 5f) || seedHit.status != EnvironmentRaycastHitStatus.Hit)
        {
            _status = "no surface under the pointer"; _busy = false; yield break;
        }
        int W = _frameTex.width, H = _frameTex.height;
        var camPose = cameraAccess.GetCameraPose();
        yield return StartCoroutine(Grab());
        if (_grabbed == null) { _status = "no camera frame"; _busy = false; yield break; }
        if (_pickBuf == null || _pickBuf.Length != W * H) _pickBuf = new Color32[W * H];
        Array.Copy(_grabbed, _pickBuf, W * H);              // its own copy: the scan may read the next picture meanwhile
        var frame = _pickBuf;
        _frameTex.SetPixelData(frame, 0);
        var seedVp = cameraAccess.WorldToViewportPoint(seedHit.point, camPose);
        if (seedVp.x < 0 || seedVp.x > 1 || seedVp.y < 0 || seedVp.y > 1) { _status = "the pointed spot is outside the camera's view: look at it"; _busy = false; yield break; }
        int nx = W / gridStep, ny = H / gridStep;
        int sx = Mathf.Clamp(Mathf.RoundToInt(seedVp.x * nx), 0, nx - 1), sy = Mathf.Clamp(Mathf.RoundToInt(seedVp.y * ny), 0, ny - 1);
        // region growing over a lazily raycast node grid: depth continuity to the neighbour, normals roughly agreeing
        var depth = new float[nx * ny]; var pts = new Vector3[nx * ny]; var nrm = new Vector3[nx * ny]; var state = new byte[nx * ny]; // 0 unknown 1 hit 2 miss
        var selected = new List<int>();
        var queue = new Queue<int>();
        bool Probe(int ix, int iy)
        {
            int k = iy * nx + ix;
            if (state[k] != 0) return state[k] == 1;
            var r = cameraAccess.ViewportPointToRay(new Vector2((ix + 0.5f) / nx, (iy + 0.5f) / ny), camPose);
            if (raycaster.Raycast(r, out var h, 6f) && h.status == EnvironmentRaycastHitStatus.Hit)
            {
                state[k] = 1; pts[k] = h.point; nrm[k] = h.normal; depth[k] = Vector3.Distance(camPose.position, h.point); return true;
            }
            state[k] = 2; return false;
        }
        if (!Probe(sx, sy)) { _status = "no depth at the pointed spot"; _busy = false; yield break; }
        var inSel = new bool[nx * ny];
        int seedK = sy * nx + sx;
        queue.Enqueue(seedK); inSel[seedK] = true;
        int budget = 0;
        while (queue.Count > 0 && selected.Count < maxNodes)
        {
            int k = queue.Dequeue(); selected.Add(k);
            int ix = k % nx, iy = k / nx;
            foreach (var (dx, dy) in new[] { (1, 0), (-1, 0), (0, 1), (0, -1) })
            {
                int jx = ix + dx, jy = iy + dy;
                if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
                int j = jy * nx + jx;
                if (inSel[j]) continue;
                if (!Probe(jx, jy)) continue;
                float join = depthJoin + 0.02f * depth[k];
                if (Mathf.Abs(depth[j] - depth[k]) > join) continue;
                if (Vector3.Distance(pts[j], seedHit.point) > maxObjectSize) continue;
                if (nrm[j] != Vector3.zero && nrm[k] != Vector3.zero && Vector3.Angle(nrm[j], nrm[k]) > 55f) continue;
                inSel[j] = true; queue.Enqueue(j);
            }
            if (++budget % 600 == 0) { _status = $"picking: {selected.Count} nodes"; yield return null; }
        }
        // the selection as pixels and as voxels
        int added = 0;
        foreach (var k in selected)
        {
            int ix = k % nx, iy = k / nx;
            int px = Mathf.Min(W - 1, ix * gridStep + gridStep / 2), py = Mathf.Min(H - 1, iy * gridStep + gridStep / 2);
            var c = frame[py * W + px];
            var v = Vector3Int.RoundToInt(pts[k] / voxelSize);
            if (_voxels.TryGetValue(v, out var vx))
            {
                vx.c = Color32.Lerp(vx.c, c, 1f / (vx.hits + 1)); vx.hits++; _voxels[v] = vx;
            }
            else { _voxels[v] = new Vox { c = c, hits = 1 }; added++; }
        }
        _captures++;
        SaveCapture(frame, W, H, seedHit.point, camPose, selected.Count, added);
        _status = $"picked {selected.Count} spots, {added} new voxels ({(Time.realtimeSinceStartupAsDouble - t0) * 1000:F0} ms)";
        if (!_scanOn) StartRecording();
        if (_scanOn)
        {
            var picked = new List<Vector3>(selected.Count);
            foreach (var k in selected) picked.Add(pts[k]);
            SetScanObject(seedHit.point, picked);
        }
        yield return StartCoroutine(FlashPixels(selected, nx, ny, camPose));
        RebuildBatches();
        _busy = false;
    }

    // ---------------------------------------------------------------- the camera picture, without stopping the frame
    // The latest camera picture -> _grabbed (null if it could not be read). The read-back from the graphics card is
    // asked for and collected a frame or two later; PassthroughCameraAccess.GetColors() waits for it on the spot,
    // and on 17 Nov 2026 the app froze for good at such a wait while it was drawing 49,000 voxels. Should the
    // waiting-free way fail three times running, the old way is used from then on.
    // Picking, the scan and the splat sensor all read through here and share its one buffer, so one read runs at a
    // time: a second caller waits its turn and then reads the picture of that later moment. A caller uses _grabbed
    // in the same step in which this returns (Unity continues the waiting coroutine at once), before the next read.
    private IEnumerator Grab()
    {
        float queued = 0f;
        while (_grabbing && queued < 1.5f) { yield return null; queued += Time.unscaledDeltaTime; }
        _grabbing = true;
        try
        {
            _grabbed = null;
            int n = _frameTex.width * _frameTex.height;
            if (_grabBuf == null || _grabBuf.Length != n) _grabBuf = new Color32[n];
            if (!_grabBlocking)
            {
                var req = AsyncGPUReadback.Request(cameraAccess.GetTexture(), 0, TextureFormat.RGBA32);
                float waited = 0f;
                while (!req.done && waited < 1f) { yield return null; waited += Time.unscaledDeltaTime; }
                if (req.done && !req.hasError)
                {
                    var d = req.GetData<Color32>();
                    if (d.IsCreated && d.Length >= n) { d.GetSubArray(0, n).CopyTo(_grabBuf); _grabbed = _grabBuf; _grabFails = 0; yield break; }
                }
                if (++_grabFails >= 3)
                {
                    _grabBlocking = true;
                    Debug.Log("[PrintSee] the waiting-free camera read failed three times: using GetColors() from now on");
                }
                yield break;
            }
            var colors = cameraAccess.GetColors();
            if (colors.IsCreated && colors.Length >= n) { colors.GetSubArray(0, n).CopyTo(_grabBuf); _grabbed = _grabBuf; }
        }
        finally { _grabbing = false; }
    }

    // ---------------------------------------------------------------- the scan
    private static string F(float v) => v.ToString("R", Inv);

    // Start keeping pictures of whatever the headset looks at (see ScanLoop). No object is needed for that: a pick
    // names one later (SetScanObject), and without any the PC still makes a splat of the surroundings.
    private void StartRecording()
    {
        if (_scanOn) return;
        try
        {
            _scanDir = Path.Combine(_dir, _objectStamp, "scan");
            if (Directory.Exists(_scanDir)) Directory.Delete(_scanDir, true);
            Directory.CreateDirectory(_scanDir);
            var intr = cameraAccess.Intrinsics; var res = cameraAccess.CurrentResolution;
            File.WriteAllText(Path.Combine(_scanDir, "camera.json"), "{" +
                $"\"app\":\"PrintWhatISee\",\"width\":{res.x},\"height\":{res.y}," +
                $"\"focalLength\":{{\"x\":{F(intr.FocalLength.x)},\"y\":{F(intr.FocalLength.y)}}}," +
                $"\"principalPoint\":{{\"x\":{F(intr.PrincipalPoint.x)},\"y\":{F(intr.PrincipalPoint.y)}}}," +
                $"\"sensorResolution\":{{\"x\":{intr.SensorResolution.x},\"y\":{intr.SensorResolution.y}}}," +
                $"\"lensOffsetPosition\":[{V(intr.LensOffset.position)}],\"lensOffsetRotation\":[{Q(intr.LensOffset.rotation)}]," +
                "\"coordinates\":\"Unity: left-handed, x right, y up, z forward; camera local +z = optical axis, +y = image up; intrinsics are for sensorResolution\"}");
            _scanFrames = new StreamWriter(Path.Combine(_scanDir, "frames.csv")) { AutoFlush = true };
            _scanFrames.WriteLine("frame,file,t_unix_ms,t_app_s,cam_px,cam_py,cam_pz,cam_qx,cam_qy,cam_qz,cam_qw,depth_hits");
        }
        catch (Exception e) { _status = "scan could not start: " + e.Message; return; }
        _scanHasObject = false; _scanPicks.Clear();
        _scanCount = 0; _scanSidesSeen = 0; _scanDepthHits = 0; _scanPrevT = 0; _scanTooFast = false;
        Array.Clear(_scanSideCount, 0, ScanSides);
        WriteScanJson(false);
        _scanOn = true;
        int gen = ++_scanGen;
        StartCoroutine(ScanLoop(gen));
        Debug.Log($"[PrintSee] SCAN start {_objectStamp}: keeping pictures of what the headset looks at");
    }

    // A pick names the object to scan: its middle and size from the picked spots near the pointed one (a pick can
    // run on along a table or a wall). A pick well away from the current object starts a new one: fresh ring, fresh
    // count of sides. Every object picked is listed in scan.json; the PC works on the one that was walked round.
    private void SetScanObject(Vector3 seed, List<Vector3> picked)
    {
        if (_scanHasObject && Vector3.Distance(seed, _scanCentre) < Mathf.Max(0.3f, _scanRadius)) return;   // the same object again
        var centre = seed; float radius = 0.12f; int near = 0;
        var min = seed; var max = seed;
        foreach (var p in picked)
        {
            if (Vector3.Distance(p, seed) > 0.35f) continue;
            min = Vector3.Min(min, p); max = Vector3.Max(max, p); near++;
        }
        if (near >= 8) { centre = (min + max) * 0.5f; radius = Mathf.Clamp((max - min).magnitude * 0.5f, 0.06f, 0.4f); }
        _scanSeed = seed; _scanCentre = centre; _scanRadius = radius; _scanHasObject = true;
        _scanSidesSeen = 0;
        Array.Clear(_scanSideCount, 0, ScanSides);
        _scanPicks.Add("{" + $"\"seed\":[{V(seed)}],\"centre\":[{V(centre)}],\"radius\":{F(radius)},\"at_picture\":{_scanCount}" + "}");
        BuildRing();
        WriteScanJson(false);
        Debug.Log($"[PrintSee] SCAN object {_scanPicks.Count}: centre {V(centre)}, radius {radius:F2} m");
    }

    private void WriteScanJson(bool saved)
    {
        if (_scanDir == null) return;
        try
        {
            // seed, centre, radius: the object picked last (none: the scan is of the surroundings); picks: all of them
            string obj = _scanHasObject ? $"\"seed\":[{V(_scanSeed)}],\"centre\":[{V(_scanCentre)}],\"radius\":{F(_scanRadius)}," : "";
            File.WriteAllText(Path.Combine(_scanDir, "scan.json"), "{" +
                $"\"name\":\"{_objectStamp}\"," + obj + $"\"picks\":[{string.Join(",", _scanPicks)}]," +
                $"\"pictures\":{_scanCount},\"sides\":{_scanSidesSeen},\"sides_total\":{ScanSides},\"depth_hits\":{_scanDepthHits},\"depth_step\":{scanDepthStep}," +
                $"\"saved\":{(saved ? "true" : "false")},\"coordinates\":\"Unity world, left-handed, y up, metres\"" + "}");
        }
        catch (Exception e) { Debug.LogWarning("[PrintSee] scan.json failed: " + e.Message); }
    }

    // sixteen dots round the object, one per side; a dot turns green once a picture was taken from its side
    private void BuildRing()
    {
        DestroyRing();
        if (rayMaterial == null) return;
        if (_ringOff == null) { _ringOff = new Material(rayMaterial) { color = new Color(0.55f, 0.55f, 0.55f) }; _ringOn = new Material(rayMaterial) { color = new Color(0.1f, 1f, 0.35f) }; }
        _scanRing = new GameObject[ScanSides];
        float r = _scanRadius + 0.15f;
        for (int i = 0; i < ScanSides; i++)
        {
            float a = (i + 0.5f) / ScanSides * 2f * Mathf.PI - Mathf.PI;
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(go.GetComponent<Collider>());
            go.name = "ScanSide" + i;
            go.transform.position = _scanCentre + new Vector3(Mathf.Cos(a), 0f, Mathf.Sin(a)) * r;
            go.transform.localScale = Vector3.one * 0.022f;
            go.GetComponent<MeshRenderer>().sharedMaterial = _ringOff;
            _scanRing[i] = go;
        }
    }

    private void DestroyRing()
    {
        if (_scanRing == null) return;
        foreach (var go in _scanRing) if (go != null) Destroy(go);
        _scanRing = null;
    }

    private void StopScan(bool discard)
    {
        _scanOn = false; _scanGen++;
        try { _scanFrames?.Dispose(); } catch { }
        _scanFrames = null;
        DestroyRing();
        if (discard && _scanDir != null) { try { if (Directory.Exists(_scanDir)) Directory.Delete(_scanDir, true); } catch { } }
        if (discard) { _scanCount = 0; _scanSidesSeen = 0; }
        _scanHasObject = false; _scanPicks.Clear();
        _scanDir = null;
    }

    private string ScanStatus()
    {
        if (_scanCount >= scanMaxPictures) return $"scan: {_scanCount} pictures, that is enough: press B to save";
        if (_scanHasObject) return $"scan: {_scanCount} pictures, {_scanSidesSeen} of {ScanSides} sides: walk slowly all the way round it, then B";
        return $"scan: {_scanCount} pictures of the room. To print something: trigger on it, then walk all the way round it";
    }

    // One picture whenever the camera has moved or turned on and is steady, whatever it looks at: the JPEG, a row in
    // frames.csv with the camera pose at the moment the picture was taken, and <name>.depth = float32 rows of 8
    // (u, v of the picture with v up; x, y, z where a ray through that spot met the depth; the surface normal there),
    // all in Unity world metres. When an object has been picked, the pictures that have it in view count its sides.
    private IEnumerator ScanLoop(int gen)
    {
        int W = _scanTex.width, H = _scanTex.height;
        int nx = W / scanDepthStep, ny = H / scanDepthStep;
        var rays = new float[nx * ny * 8];
        while (_scanOn && gen == _scanGen)
        {
            yield return null;
            if (!_scanOn || gen != _scanGen) yield break;
            if (_busy || !cameraAccess.IsPlaying || !cameraAccess.IsUpdatedThisFrame) continue;
            var pose = cameraAccess.GetCameraPose();
            double t = Time.realtimeSinceStartupAsDouble;
            float dt = (float)(t - _scanPrevT);
            float turn = dt > 1e-4f ? Quaternion.Angle(_scanPrevPose.rotation, pose.rotation) / dt : 0f;
            float move = dt > 1e-4f ? Vector3.Distance(_scanPrevPose.position, pose.position) / dt : 0f;
            _scanPrevPose = pose; _scanPrevT = t;
            if (_scanCount >= scanMaxPictures) { _statusText = ScanStatus(); continue; }
            bool movedOn = _scanCount == 0 || Vector3.Distance(pose.position, _scanLastPose.position) > scanMinMove
                           || Quaternion.Angle(pose.rotation, _scanLastPose.rotation) > scanMinTurn;
            if (!movedOn) continue;
            if (_scanCount > 0 && (turn > 25f || move > 0.3f)) { _scanTooFast = true; _statusText = $"scan: {_scanCount} pictures: slower, the picture smears"; continue; }
            _scanTooFast = false;
            yield return StartCoroutine(Grab());
            if (!_scanOn || gen != _scanGen) yield break;
            if (_grabbed == null || _busy) continue;
            _scanTex.SetPixelData(_grabbed, 0);
            var jpg = _scanTex.EncodeToJPG(92);
            int id = _scanCount;
            string name = "k" + id.ToString("D4"), dir = _scanDir;
            long tMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Task.Run(() => File.WriteAllBytes(Path.Combine(dir, name + ".jpg"), jpg));
            _scanLastPose = pose;
            _scanCount++;
            // the depth behind the picture, a few hundred rays per rendered frame
            int n = 0, cast = 0;
            for (int iy = 0; iy < ny; iy++)
                for (int ix = 0; ix < nx; ix++)
                {
                    var uv = new Vector2((ix + 0.5f) / nx, (iy + 0.5f) / ny);
                    var r = cameraAccess.ViewportPointToRay(uv, pose);
                    if (raycaster.Raycast(r, out var h, 4f) && h.status == EnvironmentRaycastHitStatus.Hit)
                    {
                        int o = n * 8;
                        rays[o] = uv.x; rays[o + 1] = uv.y;
                        rays[o + 2] = h.point.x; rays[o + 3] = h.point.y; rays[o + 4] = h.point.z;
                        rays[o + 5] = h.normal.x; rays[o + 6] = h.normal.y; rays[o + 7] = h.normal.z;
                        n++;
                    }
                    if (++cast % scanRaysPerFrame == 0)
                    {
                        yield return null;
                        if (!_scanOn || gen != _scanGen) yield break;
                    }
                }
            var bytes = new byte[n * 32];
            Buffer.BlockCopy(rays, 0, bytes, 0, n * 32);
            Task.Run(() => File.WriteAllBytes(Path.Combine(dir, name + ".depth"), bytes));
            _scanDepthHits += n;
            try
            {
                _scanFrames?.WriteLine(string.Join(",", id, name + ".jpg", tMs, t.ToString("F4", Inv), V(pose.position), Q(pose.rotation), n));
            }
            catch (Exception e) { Debug.LogWarning("[PrintSee] frames.csv: " + e.Message); }
            if (_scanHasObject)
            {
                // the side of the object this picture was taken from, if the object is in it
                var local = Quaternion.Inverse(pose.rotation) * (_scanCentre - pose.position);
                var vp = cameraAccess.WorldToViewportPoint(_scanCentre, pose);
                if (local.z > 0.15f && vp.x > 0.05f && vp.x < 0.95f && vp.y > 0.05f && vp.y < 0.95f)
                {
                    var d = pose.position - _scanCentre;
                    int side = Mathf.Clamp(Mathf.FloorToInt((Mathf.Atan2(d.z, d.x) + Mathf.PI) / (2f * Mathf.PI) * ScanSides), 0, ScanSides - 1);
                    if (_scanSideCount[side]++ == 0)
                    {
                        _scanSidesSeen++;
                        if (_scanRing != null && _scanRing[side] != null) _scanRing[side].GetComponent<MeshRenderer>().sharedMaterial = _ringOn;
                    }
                }
            }
            _statusText = ScanStatus();
            if (_scanCount % 10 == 0 || _scanCount == 1)
            {
                WriteScanJson(false);
                Debug.Log($"[PrintSee] scan: {_scanCount} pictures, {_scanSidesSeen} of {ScanSides} sides, {n} of {nx * ny} depth rays hit in the last one");
            }
        }
    }

    private bool TryControllerRay(out Ray ray)
    {
        if (rightController != null) { ray = new Ray(rightController.position, rightController.forward); return true; }
        if (_cam != null) { ray = new Ray(_cam.position, _cam.forward); return true; }
        ray = default; return false;
    }

    // ---------------------------------------------------------------- the pixel-by-pixel flash
    private IEnumerator FlashPixels(List<int> selected, int nx, int ny, Pose camPose)
    {
        ClearOverlay();
        PlaceOverlay(camPose);
        _overlayGO.SetActive(true);
        // scanline order, a few hundred pixels per frame, colour cycling as it goes
        selected.Sort((a, b) => (b / nx).CompareTo(a / nx) != 0 ? (b / nx).CompareTo(a / nx) : (a % nx).CompareTo(b % nx));
        int per = Mathf.Max(40, selected.Count / 45);
        for (int i = 0; i < selected.Count; i += per)
        {
            for (int j = i; j < Mathf.Min(selected.Count, i + per); j++)
            {
                int k = selected[j];
                float hue = (j / (float)selected.Count);
                _overlayTex.SetPixel(k % nx, k / nx, Color.HSVToRGB(0.33f + 0.4f * hue, 0.9f, 1f) * 1f + new Color(0, 0, 0, 0.85f));
            }
            _overlayTex.Apply(false);
            yield return null;
        }
        // hold, blink twice, fade
        for (int b = 0; b < 2; b++)
        {
            yield return new WaitForSeconds(0.12f); _overlayGO.SetActive(false);
            yield return new WaitForSeconds(0.08f); _overlayGO.SetActive(true);
        }
        float t = 0;
        var col = overlayMaterial.color;
        while (t < 0.6f) { t += Time.deltaTime; overlayMaterial.color = new Color(col.r, col.g, col.b, 1f - t / 0.6f); yield return null; }
        _overlayGO.SetActive(false);
        overlayMaterial.color = col;
    }

    private void ClearOverlay()
    {
        var clear = new Color32[_overlayTex.width * _overlayTex.height];
        _overlayTex.SetPixels32(clear); _overlayTex.Apply(false);
    }

    private void PlaceOverlay(Pose camPose)
    {
        if (_overlayGO == null)
        {
            _overlayGO = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(_overlayGO.GetComponent<Collider>());
            var mr = _overlayGO.GetComponent<MeshRenderer>();
            mr.material = overlayMaterial;
            overlayMaterial.mainTexture = _overlayTex;
        }
        // the quad fills the camera image at 1 m, built from the true corner rays (principal point offsets included)
        const float d = 1.0f;
        var plane = new Plane(-camPose.forward, camPose.position + camPose.forward * d);
        Vector3 P(Vector2 vp) { var r = cameraAccess.ViewportPointToRay(vp, camPose); plane.Raycast(r, out var dist); return r.GetPoint(dist); }
        var bl = P(new Vector2(0, 0)); var br = P(new Vector2(1, 0)); var tl = P(new Vector2(0, 1)); var tr = P(new Vector2(1, 1));
        var centre = (bl + br + tl + tr) / 4f;
        _overlayGO.transform.position = centre;
        _overlayGO.transform.rotation = Quaternion.LookRotation(camPose.forward, camPose.up);
        _overlayGO.transform.localScale = new Vector3((br - bl).magnitude, (tl - bl).magnitude, 1f);
    }

    // ---------------------------------------------------------------- voxels
    private static Mesh BuildCube()
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        var m = go.GetComponent<MeshFilter>().sharedMesh;
        Destroy(go);
        return m;
    }

    private void RebuildBatches()
    {
        _batches.Clear(); _batchColors.Clear();
        var mats = new List<Matrix4x4>(); var cols = new List<Vector4>();
        // every voxel is kept for the save; only so many are drawn (tens of thousands of cubes are not worth the frame time)
        int stride = Mathf.Max(1, Mathf.CeilToInt(_voxels.Count / (float)Mathf.Max(1000, maxShownVoxels))), i = 0;
        foreach (var kv in _voxels)
        {
            if (i++ % stride != 0) continue;
            if (_outline && Neighbours(kv.Key) >= 6) continue;
            mats.Add(Matrix4x4.TRS((Vector3)kv.Key * voxelSize, Quaternion.identity, Vector3.one * voxelSize * 0.92f));
            cols.Add(new Vector4(kv.Value.c.r / 255f, kv.Value.c.g / 255f, kv.Value.c.b / 255f, 1f));
            if (mats.Count == 1023) { _batches.Add(mats.ToArray()); _batchColors.Add(cols.ToArray()); mats.Clear(); cols.Clear(); }
        }
        if (mats.Count > 0) { _batches.Add(mats.ToArray()); _batchColors.Add(cols.ToArray()); }
        _shownVoxels = 0;   // they appear progressively, like the pixels did
    }

    private int Neighbours(Vector3Int v)
    {
        int n = 0;
        if (_voxels.ContainsKey(v + Vector3Int.right)) n++; if (_voxels.ContainsKey(v + Vector3Int.left)) n++;
        if (_voxels.ContainsKey(v + Vector3Int.up)) n++; if (_voxels.ContainsKey(v + Vector3Int.down)) n++;
        if (_voxels.ContainsKey(v + Vector3Int.forward)) n++; if (_voxels.ContainsKey(v + Vector3Int.back)) n++;
        return n;
    }

    private void DrawVoxels()
    {
        if (_cube == null || voxelMaterial == null || _batches.Count == 0) return;
        _shownVoxels = Mathf.Min(_shownVoxels + 120, _batches.Count * 1023);
        int remaining = _shownVoxels;
        var block = new MaterialPropertyBlock();
        for (int b = 0; b < _batches.Count && remaining > 0; b++)
        {
            int n = Mathf.Min(_batches[b].Length, remaining); remaining -= n;
            block.SetVectorArray(ColorId, _batchColors[b]);
            if (n == _batches[b].Length) Graphics.DrawMeshInstanced(_cube, 0, voxelMaterial, _batches[b], n, block);
            else { var part = new Matrix4x4[n]; Array.Copy(_batches[b], part, n); Graphics.DrawMeshInstanced(_cube, 0, voxelMaterial, part, n, block); }
        }
    }

    // ---------------------------------------------------------------- saving
    private void NewObject()
    {
        StopScan(false);
        _scanCount = 0; _scanSidesSeen = 0;
        _objectStamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss") + "_" + _objectIndex;
        _voxels.Clear(); _captures = 0; _captureMeta.Clear(); RebuildBatches();
    }

    private void SaveCapture(Color32[] frame, int W, int H, Vector3 seed, Pose camPose, int nodes, int added)
    {
        try
        {
            var dir = Path.Combine(_dir, _objectStamp); Directory.CreateDirectory(dir);
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false); tex.SetPixelData(frame, 0);
            var jpg = tex.EncodeToJPG(85); Destroy(tex);
            var path = Path.Combine(dir, $"capture_{_captures}.jpg");
            Task.Run(() => File.WriteAllBytes(path, jpg));
            var j = "{" + $"\"capture\":{_captures},\"nodes\":{nodes},\"new_voxels\":{added},\"seed\":[{V(seed)}],\"cam_pos\":[{V(camPose.position)}],\"cam_rot\":[{Q(camPose.rotation)}],\"depth_join\":{depthJoin.ToString("F3", Inv)},\"t_unix_ms\":{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}" + "}";
            File.WriteAllText(Path.Combine(dir, $"capture_{_captures}.json"), j);
            _captureMeta.Add(j);
        }
        catch (Exception e) { Debug.LogWarning("[PrintSee] capture save failed: " + e.Message); }
    }

    private void SaveObject()
    {
        if (_voxels.Count == 0 && _scanCount == 0) { _status = "nothing picked yet"; return; }
        try
        {
            var dir = Path.Combine(_dir, _objectStamp); Directory.CreateDirectory(dir);
            if (_scanCount > 0)
            {
                WriteScanJson(true);
                Debug.Log($"[PrintSee] SCAN SAVED {_objectStamp}: {_scanCount} pictures, {_scanSidesSeen} of {ScanSides} sides, {_scanDepthHits} depth points");
            }
            var sb = new StringBuilder("x,y,z,r,g,b,hits\n");
            var min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue); var max = -min;
            foreach (var kv in _voxels)
            {
                var p = (Vector3)kv.Key * voxelSize; min = Vector3.Min(min, p); max = Vector3.Max(max, p);
                sb.Append(V(p)).Append(',').Append(kv.Value.c.r).Append(',').Append(kv.Value.c.g).Append(',').Append(kv.Value.c.b).Append(',').Append(kv.Value.hits).Append('\n');
            }
            File.WriteAllText(Path.Combine(dir, "voxels.csv"), sb.ToString());
            File.WriteAllText(Path.Combine(dir, "object.json"), "{" + $"\"name\":\"{_objectStamp}\",\"voxel_m\":{voxelSize.ToString("F4", Inv)},\"voxels\":{_voxels.Count},\"captures\":{_captures},\"min\":[{V(min)}],\"max\":[{V(max)}],\"coordinates\":\"Unity world, left-handed, y up, metres\",\"captures_meta\":[{string.Join(",", _captureMeta)}]" + "}");
            _status = _scanCount > 0 ? $"saved {_scanCount} pictures and {_voxels.Count} voxels as {_objectStamp}: the PC makes the splat now"
                                     : $"saved {_voxels.Count} voxels as {_objectStamp}; pull it with quest_print_object.py";
            _lastSaved = _objectStamp;
            _objectIndex++;
            NewObject();
        }
        catch (Exception e) { _status = "save failed: " + e.Message; }
    }

    private static string V(Vector3 v) => v.x.ToString("F4", Inv) + "," + v.y.ToString("F4", Inv) + "," + v.z.ToString("F4", Inv);
    private static string Q(Quaternion q) => q.x.ToString("F5", Inv) + "," + q.y.ToString("F5", Inv) + "," + q.z.ToString("F5", Inv) + "," + q.w.ToString("F5", Inv);

    // ---------------------------------------------------------------- pointer + HUD
    private void UpdatePointer()
    {
        if (_reticle == null)
        {
            _reticle = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(_reticle.GetComponent<Collider>());
            _reticle.transform.localScale = Vector3.one * 0.02f;
            if (rayMaterial != null) _reticle.GetComponent<MeshRenderer>().material = rayMaterial;
            var lineGO = new GameObject("PointerLine");
            _ray = lineGO.AddComponent<LineRenderer>();
            _ray.startWidth = 0.003f; _ray.endWidth = 0.001f; _ray.positionCount = 2;
            if (rayMaterial != null) _ray.material = rayMaterial;
        }
        if (!_cameraReady || raycaster == null || !TryControllerRay(out var ray)) { _reticle.SetActive(false); _ray.enabled = false; return; }
        bool ok = raycaster.Raycast(ray, out var hit, 5f) && hit.status == EnvironmentRaycastHitStatus.Hit;
        _reticle.SetActive(ok); _ray.enabled = true;
        _ray.SetPosition(0, ray.origin); _ray.SetPosition(1, ok ? hit.point : ray.GetPoint(2f));
        if (ok) _reticle.transform.position = hit.point;
    }

    private void UpdateHud()
    {
        if (_cam == null) return;
        if (_hudGO == null)
        {
            _hudGO = new GameObject("PrintSeeHud");
            _hud = _hudGO.AddComponent<TextMesh>();
            _hud.fontSize = 60; _hud.characterSize = 0.0035f; _hud.anchor = TextAnchor.LowerCenter; _hud.alignment = TextAlignment.Center; _hud.color = Color.white;
            _hud.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            var mr = _hudGO.GetComponent<MeshRenderer>();
            if (mr != null && _hud.font != null) mr.material = _hud.font.material;
        }
        _hud.text = "Print What I See\n" + _status + $"\nobject {_objectIndex}: {_voxels.Count} voxels from {_captures} captures · join {depthJoin * 100:F0} cm · {(_outline ? "outline" : "solid")}"
                    + "\ntrigger on ONE thing, walk all the way round it, B to save · A clear · grip outline";
        var pos = _cam.position + _cam.forward * 1.4f - _cam.up * 0.45f;
        _hudGO.transform.position = pos;
        _hudGO.transform.rotation = Quaternion.LookRotation(pos - _cam.position, Vector3.up);
    }
}

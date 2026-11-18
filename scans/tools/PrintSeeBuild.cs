// Builds the Print What I See APK:
//   Unity.exe -projectPath <this project> -buildTarget Android -batchmode -quit -executeMethod PrintSeeBuild.BuildAPK
using System.IO;
using Meta.XR;
using Meta.XR.MRUtilityKit;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class PrintSeeBuild
{
    private const string ScenePath = "Assets/Scenes/PrintSee.unity";
    private const string ApkPath = "Builds/PrintWhatISee.apk";
    private const string AppId = "com.mersivity.printsee";

    private static Material MakeMaterial(string path, string shaderName, Color color, bool instancing)
    {
        var shader = Shader.Find(shaderName);
        if (shader == null) { Debug.LogError("[PrintSee] shader not found: " + shaderName); shader = Shader.Find("Standard"); }
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null) { m = new Material(shader); AssetDatabase.CreateAsset(m, path); }
        m.shader = shader; m.color = color; m.enableInstancing = instancing;
        if (instancing) { m.SetFloat("_Glossiness", 0.1f); m.SetFloat("_Metallic", 0f); }
        EditorUtility.SetDirty(m);
        return m;
    }

    [MenuItem("Mersivity/Print What I See/1. Setup Scene")]
    public static void SetupScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        if (!Directory.Exists("Assets/Scenes")) Directory.CreateDirectory("Assets/Scenes");
        if (!Directory.Exists("Assets/PrintSee/Materials")) Directory.CreateDirectory("Assets/PrintSee/Materials");
        var overlay = MakeMaterial("Assets/PrintSee/Materials/overlay.mat", "Unlit/Transparent", Color.white, false);
        var voxel = MakeMaterial("Assets/PrintSee/Materials/voxel.mat", "Standard", Color.white, true);
        var ray = MakeMaterial("Assets/PrintSee/Materials/ray.mat", "Unlit/Color", new Color(0.2f, 1f, 0.6f), false);
        AssetDatabase.SaveAssets();

        var rigGO = new GameObject("OVRCameraRig");
        var rig = rigGO.AddComponent<OVRCameraRig>();
        var mgr = rigGO.GetComponent<OVRManager>();
        if (mgr == null) mgr = rigGO.AddComponent<OVRManager>();
        var so = new SerializedObject(mgr);
        SetBool(so, "isInsightPassthroughEnabled", true);
        SetBool(so, "_isInsightPassthroughEnabled", true);
        so.ApplyModifiedProperties();
        rigGO.AddComponent<OVRPassthroughLayer>();
        var centerEye = rigGO.transform.Find("TrackingSpace/CenterEyeAnchor") ?? rigGO.transform;
        var cam = centerEye.GetComponent<Camera>();
        if (cam == null) cam = centerEye.gameObject.AddComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0, 0, 0, 0);
        cam.nearClipPlane = 0.05f;
        cam.tag = "MainCamera";
        var rightController = rigGO.transform.Find("TrackingSpace/RightControllerAnchor");

        var lightGO = new GameObject("Directional Light");
        var light = lightGO.AddComponent<Light>();
        light.type = LightType.Directional; light.intensity = 0.9f;
        lightGO.transform.rotation = Quaternion.Euler(50, -30, 0);

        var camGO = new GameObject("PassthroughCamera");
        var pca = camGO.AddComponent<PassthroughCameraAccess>();
        pca.CameraPosition = PassthroughCameraAccess.CameraPositionType.Left;
        pca.RequestedResolution = new Vector2Int(1280, 960);
        var pso = new SerializedObject(pca);
        var fr = pso.FindProperty("_maxFramerate"); if (fr != null) fr.intValue = 30;
        pso.ApplyModifiedProperties();
        pca.enabled = false;

        var rayGO = new GameObject("EnvironmentRaycast");
        var raycaster = rayGO.AddComponent<EnvironmentRaycastManager>();
        raycaster.enabled = false;   // the app enables it once the room permission is granted

        var appGO = new GameObject("PrintWhatISee");
        var app = appGO.AddComponent<PrintWhatISee>();
        app.cameraAccess = pca; app.raycaster = raycaster; app.rightController = rightController;
        app.overlayMaterial = overlay; app.voxelMaterial = voxel; app.rayMaterial = ray;

        EditorSceneManager.MarkSceneDirty(scene);
        EditorSceneManager.SaveScene(scene, ScenePath);
        Debug.Log("[PrintSee] scene written: " + ScenePath);
    }

    [MenuItem("Mersivity/Print What I See/2. Build APK")]
    public static void BuildAPK()
    {
        SetupScene();
        PlayerSettings.companyName = "Mersivity";
        PlayerSettings.productName = "Print What I See";
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, AppId);
        WriteManifest();
        if (!Directory.Exists("Builds")) Directory.CreateDirectory("Builds");
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = new[] { ScenePath }, locationPathName = ApkPath, target = BuildTarget.Android, options = BuildOptions.None });
        if (report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded)
            Debug.Log("[PrintSee] Build succeeded: " + ApkPath);
        else
        {
            Debug.LogError("[PrintSee] Build failed: " + report.summary.result);
            if (Application.isBatchMode) EditorApplication.Exit(1);
        }
    }

    private static void WriteManifest()
    {
        const string path = "Assets/Plugins/Android/AndroidManifest.xml";
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, @"<?xml version=""1.0"" encoding=""utf-8""?>
<manifest xmlns:android=""http://schemas.android.com/apk/res/android""
    package=""" + AppId + @""">

    <uses-permission android:name=""android.permission.INTERNET"" />
    <uses-permission android:name=""android.permission.CAMERA"" />
    <uses-permission android:name=""horizonos.permission.HEADSET_CAMERA"" />
    <uses-permission android:name=""com.oculus.permission.USE_SCENE"" />
    <uses-permission android:name=""com.oculus.permission.USE_ANCHOR_API"" />

    <uses-feature android:name=""android.hardware.vr.headtracking"" android:required=""true"" />
    <uses-feature android:name=""android.hardware.camera"" android:required=""false"" />

    <application android:allowBackup=""false"">
        <meta-data android:name=""com.oculus.supportedDevices"" android:value=""quest3|quest3s"" />
        <meta-data android:name=""com.oculus.ossplash"" android:value=""true"" />
        <meta-data android:name=""com.oculus.mr.environment_passthrough"" android:value=""true"" />

        <activity android:name=""com.unity3d.player.UnityPlayerGameActivity""
            android:theme=""@android:style/Theme.Black.NoTitleBar.Fullscreen""
            android:configChanges=""density|fontScale|keyboard|keyboardHidden|layoutDirection|locale|mcc|mnc|navigation|orientation|screenLayout|screenSize|smallestScreenSize|touchscreen|uiMode""
            android:launchMode=""singleTask""
            android:exported=""true"">
            <intent-filter>
                <action android:name=""android.intent.action.MAIN"" />
                <category android:name=""android.intent.category.LAUNCHER"" />
                <category android:name=""com.oculus.intent.category.VR"" />
            </intent-filter>
        </activity>
    </application>
</manifest>
");
    }

    private static void SetBool(SerializedObject so, string name, bool val)
    {
        var p = so.FindProperty(name);
        if (p != null && p.propertyType == SerializedPropertyType.Boolean) p.boolValue = val;
    }
}

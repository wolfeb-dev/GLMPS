// glmps-tap-setup.exe: extracts its embedded payload (the signed tap bundle) to a
// temp folder and runs the bundled node.exe on taps\tap-setup.mjs, passing its
// own path so setup can read the server URL from the filename. Everything else is
// in tested JS. Built by apps/tap/scripts/release-tap.mjs with the .NET Framework
// csc.exe that ships with Windows, so it stays C# 5.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

static class Setup
{
    static int Main(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string tmp = Path.Combine(Path.GetTempPath(), "glmps-tap-setup-" + Guid.NewGuid().ToString("N"));
        bool interactive = Array.IndexOf(args, "--code") < 0 && Array.IndexOf(args, "--uninstall") < 0;
        int code = 1;
        try
        {
            Console.WriteLine("GLMPS tap setup: unpacking...");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new InvalidOperationException("this installer has no payload");
                using (ZipArchive z = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    z.ExtractToDirectory(tmp);
                }
            }
            StringBuilder cmd = new StringBuilder();
            cmd.Append(Quote(Path.Combine(tmp, "taps", "tap-setup.mjs")));
            cmd.Append(" --installer ").Append(Quote(self));
            foreach (string a in args) cmd.Append(' ').Append(Quote(a));
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(tmp, "node.exe"), cmd.ToString());
            psi.UseShellExecute = false;
            psi.WorkingDirectory = tmp;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                code = p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("GLMPS tap setup failed: " + e.Message);
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch (Exception) { }
        }
        if (interactive)
        {
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
        }
        return code;
    }

    // CommandLineToArgvW rules: backslashes double only before a quote.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
        StringBuilder b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); slashes = 0; b.Append('"'); continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(c);
        }
        b.Append('\\', slashes * 2).Append('"');
        return b.ToString();
    }
}

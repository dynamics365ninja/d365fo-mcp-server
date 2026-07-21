using System;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Pure, dependency-free helpers for the form authoring surface (create/add-control).
    ///
    /// Deliberately references NO Microsoft.Dynamics.* type so it can be compiled and
    /// unit-tested away from a D365FO installation — see
    /// tests/bridge/formAuthoringDefaults.test.ts, which compiles THIS FILE with the
    /// plain .NET SDK and asserts the behaviour below without an AOS or a metadata model.
    /// </summary>
    internal static class FormAuthoringDefaults
    {
        /// <summary>Name of the method that carries a form's class declaration in AxForm XML.</summary>
        public const string ClassDeclarationMethodName = "classDeclaration";

        /// <summary>True when <paramref name="methodName"/> denotes the form class declaration.</summary>
        public static bool IsClassDeclarationMethod(string? methodName)
            => methodName != null
               && string.Equals(methodName.Trim(), ClassDeclarationMethodName, StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// True when <paramref name="parentControl"/> addresses the form DESIGN ROOT rather than a
        /// named control inside it.
        ///
        /// Why this exists: AddControl used to resolve its parent purely with
        /// FindControlRecursive(design, parentControl), which only ever walks design.Controls and
        /// therefore can NEVER return the design itself. On a form whose design has no controls yet,
        /// every possible parentControl value failed by construction, so a form could never receive
        /// its FIRST top-level control (corpus: 2026-07-21T18__L2-form-modify-controls__c262b19).
        ///
        /// Recognised sentinels: null / empty / whitespace, "Design", "FormDesign", "Root",
        /// the form name itself, and "&lt;FormName&gt;Design" — i.e. every spelling an agent
        /// plausibly reaches for when it wants "put this at the top level".
        /// </summary>
        public static bool IsDesignRootSentinel(string? parentControl, string? formName)
        {
            if (string.IsNullOrWhiteSpace(parentControl)) return true;

            var p = parentControl!.Trim();
            if (string.Equals(p, "Design", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "FormDesign", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "Root", StringComparison.OrdinalIgnoreCase)) return true;

            if (!string.IsNullOrWhiteSpace(formName))
            {
                var f = formName!.Trim();
                if (string.Equals(p, f, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(p, f + "Design", StringComparison.OrdinalIgnoreCase)) return true;
            }

            return false;
        }

        /// <summary>
        /// The class declaration every AxForm must carry. Without it xppc fails with
        /// "The 'classDeclaration' is missing from element '&lt;Form&gt;'", i.e. a bridge-created
        /// form was dead on arrival (corpus: 2026-07-21T18__L2-form-modify-controls__c262b19).
        /// Shape mirrors GenerateD365Xml.generateAxFormXml (src/tools/generateD365Xml.ts) so the
        /// bridge create path and the XML fallback produce the same form.
        /// </summary>
        public static string DefaultFormClassDeclaration(string formName)
            => "[Form]\npublic class " + formName + " extends FormRun\n{\n}\n";
    }
}

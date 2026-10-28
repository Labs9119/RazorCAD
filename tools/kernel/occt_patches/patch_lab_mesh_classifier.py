#!/usr/bin/env python3
"""(Kernel Lab) Idempotently patch BRepMesh_Classifier so a point is tested only against the wires whose own box
can hold it: the same answer for every point, found without walking every wire's polygon.

WHAT IT COSTS NOW (OCCT b8f597c677): BRepMesh_Classifier::Perform, asked whether a candidate inner node of a face is
inside it, calls CSLib_Class2d::SiDans for every wire of the face in turn. SiDans' quick box test uses the FACE's
UV range (RegisterWire gives each wire's CSLib_Class2d the face range), so it never rejects: every point walks
every wire's polygon, five times (internalSiDansOuOn, then internalSiDans at four offsets when the tolerance is
not zero). A face with 166 holes: 265 of the 551 ms its meshing takes.

THE CHANGE: RegisterWire also keeps each wire's own box (its points' UV extent), widened by twice the UV tolerance
and 1e-9 of the face range. A point outside that box is Outside for that wire, exactly as SiDans would say, by the
same arithmetic: every polygon vertex lies strictly to one side of it (and of its four offset points) in U, or
in V, so no vertex or edge is ON within the tolerance, the ray to +U crosses the closed polygon an even number of
times (or never), and the four offset points are outside too, so the result is not made Uncertain. Perform then
takes, for that wire, the branch SiDans' Outside takes (an outer wire: OUT; a hole: go on) without calling it.
Wires SiDans cannot classify (fewer than 3 points, a face range of 1e-10 or less) keep an infinite box: always
tested. Same wires, same order, same results.

Reversible via `git checkout` in the OCCT tree.
"""

import hashlib
import os
import sys

FILES = {
    "BRepMesh_Classifier.hxx": (
        "9bf7938786fa8895d96141a4538bb14f8d5e40ee5573b831ba379b30fafb3264",
        [
            ("#include <memory>\n", "#include <memory>\n#include <array>\n#include <vector>\n"),
            (
                "  IMeshData::VectorOfBoolean                                  myTabOrient;\n",
                "  IMeshData::VectorOfBoolean                                  myTabOrient;\n"
                "  // (Kernel Lab) each wire's own UV box, widened (umin, umax, vmin, vmax): a point outside it is\n"
                "  // Outside for that wire without walking its polygon\n"
                "  std::vector<std::array<double, 4>>                          myLabBoxes;\n",
            ),
        ],
    ),
    "BRepMesh_Classifier.cxx": (
        "31698f27069eea62a7f41f1727a829095a11b3b57a0734f516e357cf2398673c",
        [
            (
                "  bool isOut = false;\n  int  aNb   = myTabClass.Length();\n\n  for (int i = 0; i < aNb; i++)\n  {\n",
                "  bool isOut = false;\n  int  aNb   = myTabClass.Length();\n\n"
                "  const double aLabX = thePoint.X(), aLabY = thePoint.Y();\n"
                "  const bool   aLabBoxes = static_cast<int>(myLabBoxes.size()) == aNb;\n"
                "  for (int i = 0; i < aNb; i++)\n  {\n"
                "    // (Kernel Lab) outside the wire's own box: SiDans would say Outside (see RegisterWire)\n"
                "    if (aLabBoxes)\n"
                "    {\n"
                "      const std::array<double, 4>& aBox = myLabBoxes[i];\n"
                "      if (aLabX < aBox[0] || aLabX > aBox[1] || aLabY < aBox[2] || aLabY > aBox[3])\n"
                "      {\n"
                "        if (myTabOrient(i))\n"
                "        {\n"
                "          return TopAbs_OUT;\n"
                "        }\n"
                "        continue;\n"
                "      }\n"
                "    }\n",
            ),
            (
                "  myTabOrient.Append(!(anAngle < 0.0));\n",
                "  myTabOrient.Append(!(anAngle < 0.0));\n"
                "  // (Kernel Lab) the wire's own box, widened by twice the tolerance and 1e-9 of the face range (rounding\n"
                "  // in SiDans' normalisation is far smaller); infinite where SiDans cannot classify (it says Uncertain)\n"
                "  {\n"
                "    constexpr double aInf    = std::numeric_limits<double>::infinity();\n"
                "    const double     aRangeU = theRangeU.second - theRangeU.first;\n"
                "    const double     aRangeV = theRangeV.second - theRangeV.first;\n"
                "    std::array<double, 4> aBox = {-aInf, aInf, -aInf, aInf};\n"
                "    if (aNbPnts >= 3 && aRangeU > 1e-10 && aRangeV > 1e-10)\n"
                "    {\n"
                "      double aU0 = aInf, aU1 = -aInf, aV0 = aInf, aV1 = -aInf;\n"
                "      for (int i = aPClass.Lower(); i <= aPClass.Upper(); i++)\n"
                "      {\n"
                "        const gp_Pnt2d& aP = aPClass(i);\n"
                "        aU0 = std::min(aU0, aP.X()); aU1 = std::max(aU1, aP.X());\n"
                "        aV0 = std::min(aV0, aP.Y()); aV1 = std::max(aV1, aP.Y());\n"
                "      }\n"
                "      const double aMarginU = 2.0 * std::abs(theTolUV.first) + 1e-9 * aRangeU;\n"
                "      const double aMarginV = 2.0 * std::abs(theTolUV.second) + 1e-9 * aRangeV;\n"
                "      if (std::isfinite(aU0) && std::isfinite(aU1) && std::isfinite(aV0) && std::isfinite(aV1))\n"
                "      {\n"
                "        aBox = {aU0 - aMarginU, aU1 + aMarginU, aV0 - aMarginV, aV1 + aMarginV};\n"
                "      }\n"
                "    }\n"
                "    myLabBoxes.push_back(aBox);\n"
                "  }\n",
            ),
            (
                "#include <NCollection_Array1.hxx>\n",
                "#include <NCollection_Array1.hxx>\n#include <algorithm>\n#include <cmath>\n#include <limits>\n",
            ),
        ],
    ),
}
MARK = "(Kernel Lab)"


def main():
    occt_root = os.environ.get("OCCT_ROOT", "")
    if not occt_root:
        print("ERROR: OCCT_ROOT not set")
        sys.exit(1)
    base = os.path.join(occt_root, "src", "ModelingAlgorithms", "TKMesh", "BRepMesh")
    for name, (pristine, reps) in FILES.items():
        path = os.path.join(base, name)
        with open(path, encoding="utf-8") as f:
            content = f.read()
        if MARK in content:
            print(f"Already patched: {path}")
            continue
        actual = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if actual != pristine:
            print(f"ERROR: unexpected source for {path}: {actual} (expected {pristine})")
            sys.exit(1)
        for anchor, repl in reps:
            n = content.count(anchor)
            if n != 1:
                print(f"ERROR: expected 1 occurrence of an anchor in {name}, found {n}:\n{anchor}")
                sys.exit(1)
            content = content.replace(anchor, repl, 1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Patched: {path}")


if __name__ == "__main__":
    main()

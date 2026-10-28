#!/usr/bin/env python3
"""(Kernel Lab) Idempotently patch BRepClass3d so a solid classifier makes each face's intersector only when it is
first needed, and the infinite-point classification skips the faces the probing line cannot meet: the same states,
found without building and running an intersector for every face.

WHAT IT COSTS NOW (OCCT b8f597c677): BRepClass3d_SolidExplorer::InitShape builds an IntCurvesFace_Intersector
(which samples the face's surface into a polyhedron) for EVERY face, and BRepClass3d_SClassifier::
PerformInfinitePoint intersects its probing line with every face. Booleans classify this way whether a shell is a
hole (BOPAlgo_BuilderSolid::PerformAreas -> IsHole) and whether an argument solid is inverted (FillIn3DParts ->
IsInvertedSolid): on a body with a few hundred faces, about 0.29 s per boolean on the critical path, and 1 s of CPU
more in other classifications.

THE CHANGE:
1. InitShape keeps each face (the one met last, as the map's Bind left it) and no intersector; Intersector(F) and
   PointInTheFace build it from that kept face when first asked (the same constructor arguments as before), so
   every intersector is the one the original would have built.
2. PerformInfinitePoint first asks LabRejectFace(face, line): true only when the face is of a surface kind whose
   geometric box holds it (plane, cylinder, cone, sphere, torus, Bezier, B-spline: BRepBndLib::Add without the
   triangulation), its intersector is the restricted one (not rebuilt unrestricted by OtherSegment), and the whole
   line misses that box widened by more than every tolerance on the face (10 x its largest edge / vertex
   tolerance, 1e-3 of the box's size, 1e-4). IntCurvesFace_Intersector only reports points on the face (IN or ON,
   within its tolerance), all inside that widened box, so for such a face it would report none: skipping it leaves
   parmin, the state and the transition exactly as they were.

Reversible via `git checkout` in the OCCT tree.
"""

import hashlib
import os
import sys

BASE = ("src", "ModelingAlgorithms", "TKTopAlgo", "BRepClass3d")
FILES = {
    "BRepClass3d_SolidExplorer.hxx": (
        "e730c4b2b8f19feb556a44b3792812da86c68aa814c6d9bc62484a934fc954c6",
        [
            (
                "#include <NCollection_IndexedMap.hxx>\n",
                "#include <NCollection_IndexedMap.hxx>\n#include <NCollection_Map.hxx>\n#include <Bnd_Box.hxx>\n#include <TopoDS_Face.hxx>\n",
            ),
            (
                "  Standard_EXPORT IntCurvesFace_Intersector& Intersector(const TopoDS_Face& F) const;\n",
                "  Standard_EXPORT IntCurvesFace_Intersector& Intersector(const TopoDS_Face& F) const;\n"
                "\n"
                "  //! (Kernel Lab) True when the line cannot meet face F (its widened geometric box is missed) and F's\n"
                "  //! intersector would therefore report no point: see BRepClass3d_SClassifier::PerformInfinitePoint.\n"
                "  Standard_EXPORT bool LabRejectFace(const TopoDS_Face& F, const gp_Lin& L) const;\n",
            ),
            (
                "  NCollection_DataMap<TopoDS_Shape, void*, TopTools_ShapeMapHasher> myMapOfInter;\n",
                "  // (Kernel Lab) mutable: each face's intersector is made when first asked for (nullptr until then)\n"
                "  mutable NCollection_DataMap<TopoDS_Shape, void*, TopTools_ShapeMapHasher> myMapOfInter;\n"
                "  // (Kernel Lab) the face each intersector is made from (as InitShape met it); faces whose intersector\n"
                "  // was made unrestricted; faces' widened boxes (void: never rejected)\n"
                "  mutable NCollection_DataMap<TopoDS_Shape, TopoDS_Face, TopTools_ShapeMapHasher> myLabFaceOf;\n"
                "  mutable NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>                   myLabNoRestr;\n"
                "  mutable NCollection_DataMap<TopoDS_Shape, Bnd_Box, TopTools_ShapeMapHasher>     myLabBox;\n",
            ),
        ],
    ),
    "BRepClass3d_SolidExplorer.cxx": (
        None,  # (hash taken below)
        [
            (
                "#include <TopExp.hxx>\n",
                "#include <TopExp.hxx>\n#include <BRepAdaptor_Surface.hxx>\n#include <GeomAbs_SurfaceType.hxx>\n#include <algorithm>\n#include <cmath>\n",
            ),
            (
                "  if (myMapOfInter.IsBound(Face))\n  {\n    void* ptr      = (void*)(myMapOfInter.Find(Face));\n",
                "  if (myMapOfInter.IsBound(Face))\n  {\n"
                "    // (Kernel Lab) made now if not yet\n"
                "    void* ptr      = (void*)(&Intersector(Face));\n",
            ),
            (
                "            myMapOfInter.UnBind(face);\n"
                "            void* ptr =\n"
                "              (void*)(new IntCurvesFace_Intersector(face, Precision::Confusion(), aRestr, false));\n"
                "            myMapOfInter.Bind(face, ptr);\n",
                "            myMapOfInter.UnBind(face);\n"
                "            void* ptr =\n"
                "              (void*)(new IntCurvesFace_Intersector(face, Precision::Confusion(), aRestr, false));\n"
                "            myMapOfInter.Bind(face, ptr);\n"
                "            myLabNoRestr.Add(face); // (Kernel Lab) its points can lie outside the face: never rejected\n",
            ),
            (
                "  myMapOfInter.Clear();\n\n  myReject = true; //-- case of infinite solid (without any face)\n",
                "  myMapOfInter.Clear();\n  myLabFaceOf.Clear();\n  myLabNoRestr.Clear();\n  myLabBox.Clear();\n\n"
                "  myReject = true; //-- case of infinite solid (without any face)\n",
            ),
            (
                "    void* ptr = (void*)(new IntCurvesFace_Intersector(Face, Precision::Confusion(), true, false));\n"
                "    myMapOfInter.Bind(Face, ptr);\n",
                "    // (Kernel Lab) the intersector is made from this face when first asked for (Intersector)\n"
                "    myMapOfInter.Bind(Face, nullptr);\n"
                "    myLabFaceOf.Bind(Face, Face);\n",
            ),
            (
                "IntCurvesFace_Intersector& BRepClass3d_SolidExplorer::Intersector(const TopoDS_Face& F) const\n"
                "{\n"
                "  void*                      ptr  = (void*)(myMapOfInter.Find(F));\n",
                "IntCurvesFace_Intersector& BRepClass3d_SolidExplorer::Intersector(const TopoDS_Face& F) const\n"
                "{\n"
                "  // (Kernel Lab) made when first asked for, from the face InitShape met, as InitShape made it before\n"
                "  void*& aSlot = myMapOfInter.ChangeFind(F);\n"
                "  if (aSlot == nullptr)\n"
                "  {\n"
                "    const TopoDS_Face* aKept = myLabFaceOf.Seek(F);\n"
                "    aSlot = (void*)(new IntCurvesFace_Intersector(aKept ? *aKept : F, Precision::Confusion(), true, false));\n"
                "  }\n"
                "  void*                      ptr  = aSlot;\n",
            ),
            (
                "//=======================================================================\n// function : Destroy\n",
                "//=================================================================================================\n"
                "\n"
                "bool BRepClass3d_SolidExplorer::LabRejectFace(const TopoDS_Face& F, const gp_Lin& L) const\n"
                "{\n"
                "  // (Kernel Lab) see the header; any doubt: false (the face is intersected as before)\n"
                "  if (myLabNoRestr.Contains(F))\n"
                "  {\n"
                "    return false;\n"
                "  }\n"
                "  const Bnd_Box* aBox = myLabBox.Seek(F);\n"
                "  if (aBox == nullptr)\n"
                "  {\n"
                "    Bnd_Box aB; // void: never rejected\n"
                "    try\n"
                "    {\n"
                "      const GeomAbs_SurfaceType aT = BRepAdaptor_Surface(F, false).GetType();\n"
                "      const bool aSure = aT == GeomAbs_Plane || aT == GeomAbs_Cylinder || aT == GeomAbs_Cone\n"
                "                         || aT == GeomAbs_Sphere || aT == GeomAbs_Torus || aT == GeomAbs_BezierSurface\n"
                "                         || aT == GeomAbs_BSplineSurface;\n"
                "      if (aSure)\n"
                "      {\n"
                "        Bnd_Box aG;\n"
                "        BRepBndLib::Add(F, aG, false);\n"
                "        if (!aG.IsVoid() && !aG.IsWhole() && !aG.IsOpen())\n"
                "        {\n"
                "          double aX0, aY0, aZ0, aX1, aY1, aZ1;\n"
                "          aG.Get(aX0, aY0, aZ0, aX1, aY1, aZ1);\n"
                "          const double aSize = std::max(aX1 - aX0, std::max(aY1 - aY0, aZ1 - aZ0));\n"
                "          const double aTol  = std::max(BRep_Tool::MaxTolerance(F, TopAbs_EDGE),\n"
                "                                       std::max(BRep_Tool::MaxTolerance(F, TopAbs_VERTEX),\n"
                "                                                BRep_Tool::Tolerance(F)));\n"
                "          if (std::isfinite(aSize) && std::isfinite(aTol))\n"
                "          {\n"
                "            aG.Enlarge(std::max(10.0 * aTol, 1e-3 * aSize) + 1e-4);\n"
                "            aB = aG;\n"
                "          }\n"
                "        }\n"
                "      }\n"
                "    }\n"
                "    catch (...)\n"
                "    {\n"
                "      aB.SetVoid();\n"
                "    }\n"
                "    myLabBox.Bind(F, aB);\n"
                "    aBox = myLabBox.Seek(F);\n"
                "  }\n"
                "  return !aBox->IsVoid() && aBox->IsOut(L);\n"
                "}\n"
                "\n"
                "//=======================================================================\n// function : Destroy\n",
            ),
            (
                "  myMapOfInter.Clear();\n}\n",
                "  myMapOfInter.Clear();\n  myLabFaceOf.Clear();\n  myLabNoRestr.Clear();\n  myLabBox.Clear();\n}\n",
            ),
        ],
    ),
    "BRepClass3d_SClassifier.cxx": (
        "ab964e9f84cebca3daf9af3efba98eb2438db49de1de17f04fe34f3e76562884",
        [
            (
                "            if (!aSE.RejectFace(aLin))\n"
                "            {\n"
                "              TopoDS_Shape               aLocalShape   = aSE.CurrentFace();\n"
                "              TopoDS_Face                CurFace       = TopoDS::Face(aLocalShape);\n"
                "              IntCurvesFace_Intersector& Intersector3d = aSE.Intersector(CurFace);\n"
                "              Intersector3d.Perform(aLin, -RealLast(), parmin);\n",
                "            // (Kernel Lab) a face the line cannot meet would report no point: not intersected (and its\n"
                "            // intersector not made)\n"
                "            if (!aSE.RejectFace(aLin) && !aSE.LabRejectFace(TopoDS::Face(aSE.CurrentFace()), aLin))\n"
                "            {\n"
                "              TopoDS_Shape               aLocalShape   = aSE.CurrentFace();\n"
                "              TopoDS_Face                CurFace       = TopoDS::Face(aLocalShape);\n"
                "              IntCurvesFace_Intersector& Intersector3d = aSE.Intersector(CurFace);\n"
                "              Intersector3d.Perform(aLin, -RealLast(), parmin);\n",
            ),
        ],
    ),
}
MARK = "(Kernel Lab)"
SOLIDEXPLORER_CXX_SHA = "9462dbb00db11bba06d52e291d58b6e99d8d87260392a8107fa3067cfb60fe46"


def main():
    occt_root = os.environ.get("OCCT_ROOT", "")
    if not occt_root:
        print("ERROR: OCCT_ROOT not set")
        sys.exit(1)
    base = os.path.join(occt_root, *BASE)
    for name, (pristine, reps) in FILES.items():
        pristine = pristine or SOLIDEXPLORER_CXX_SHA
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

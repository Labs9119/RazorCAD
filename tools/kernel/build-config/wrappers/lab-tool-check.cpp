// Kernel Lab (k1): do the solids of a compound touch or overlap each other?
//
// `LabToolCheck::Interferences(compound, fuzzy)` runs OpenCascade's self-interference checker (BOPAlgo_CheckerSI) on
// the compound, as BOPAlgo_ArgumentAnalyzer does, and counts the interfering pairs of sub-shapes it records
// (vertex/edge/face pairs, and vertex/edge/face/solid in another solid, so a solid lying wholly inside another counts
// too). 0: no two solids touch or overlap (and none intersects itself); -1: the checker failed (treat as unknown).
// With threads (the multi-threaded build) the checker runs in parallel when BOPAlgo_Options' parallel mode is on.
//
// `LabToolCheck::Classify(solid, x, y, z, tol)`: where a point is relative to a solid (BRepClass3d_SolidClassifier):
// 0 IN, 1 OUT, 2 ON, 3 UNKNOWN (TopAbs_State's order).

#include <BOPAlgo_CheckerSI.hxx>
#include <BOPDS_DS.hxx>
#include <BOPDS_MapOfPair.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <NCollection_List.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>

class LabToolCheck {
public:
  static int Interferences(const TopoDS_Shape& compound, double fuzzy) {
    BOPAlgo_CheckerSI checker;
    NCollection_List<TopoDS_Shape> args;
    args.Append(compound);
    checker.SetArguments(args);
    checker.SetNonDestructive(true);
    if (fuzzy > 0) checker.SetFuzzyValue(fuzzy);
    checker.Perform();
    if (checker.HasErrors()) return -1;
    const BOPDS_DS& ds = *checker.PDS();
    int n = 0;
    for (BOPDS_MapOfPair::Iterator it(ds.Interferences()); it.More(); it.Next()) {
      Standard_Integer a = 0, b = 0;
      it.Value().Indices(a, b);
      if (ds.IsNewShape(a) || ds.IsNewShape(b)) continue;
      n++;
    }
    return n;
  }

  // (diagnostic) the interferences by kind: volume = sub-shapes lying inside another solid (VZ EZ FZ ZZ: volume
  // shared); boundary = contacts and crossings of boundaries (VV VE EE VF EF FF). -1: the checker failed.
  static int VolumeInterferences(const TopoDS_Shape& compound) { return Kinds(compound, true); }
  static int BoundaryInterferences(const TopoDS_Shape& compound) { return Kinds(compound, false); }

  static int Kinds(const TopoDS_Shape& compound, bool volume) {
    BOPAlgo_CheckerSI checker;
    NCollection_List<TopoDS_Shape> args;
    args.Append(compound);
    checker.SetArguments(args);
    checker.SetNonDestructive(true);
    checker.Perform();
    if (checker.HasErrors()) return -1;
    BOPDS_DS& ds = *checker.PDS();
    if (volume) return ds.InterfVZ().Length() + ds.InterfEZ().Length() + ds.InterfFZ().Length() + ds.InterfZZ().Length();
    return ds.InterfVV().Length() + ds.InterfVE().Length() + ds.InterfEE().Length() + ds.InterfVF().Length()
      + ds.InterfEF().Length() + ds.InterfFF().Length();
  }

  static int Classify(const TopoDS_Shape& solid, double x, double y, double z, double tol) {
    BRepClass3d_SolidClassifier classifier(solid, gp_Pnt(x, y, z), tol);
    return static_cast<int>(classifier.State());
  }
};

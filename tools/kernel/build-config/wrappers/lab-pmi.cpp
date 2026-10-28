// Kernel Lab (k14): defeaturing and STEP files with semantic PMI.
//
// `LabDefeature::Remove(shape, faces, parallel)`: OpenCascade's defeaturing (BRepAlgoAPI_Defeaturing) takes the faces
// of the compound `faces` out of the solid and lets the faces round them grow or shrink to close the gap: fillets,
// chamfers, holes, bosses, blends at corners. An empty shape on failure; `LabDefeature::LastError()` says why.
//
// `LabPMI::WriteStep(shape, name, spec)`: the shape as an AP242 STEP file (the text) with dimensions, geometric
// tolerances and datums as semantic PMI (XCAF DimTol, written with the writer's GD&T mode). spec: one annotation a
// line, fields split by '|', points as "x y z"; each refers to the face of the shape nearest its point(s):
//   D|letter|p                          a datum on the face at p
//   T|kind|value|dia|p|A,B,C            a geometric tolerance (kind: flatness, position, …; dia 1: a Ø zone) on the
//                                        face at p, referring to the datums named
//   L|value|upper|lower|p|q|t           a linear distance between the faces at p and q (upper / lower deviations),
//                                        its text at t
// `LabPMI::ReadStep(text)`: the PMI of a STEP file, one line each in the same form (L|value|upper|lower|p|q|t,
// T|kind|value|dia|p|datums, D|letter|p; points: the annotations' own or the middle of the faces they refer to).

#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <Bnd_Box.hxx>
#include <Interface_Static.hxx>
#include <Message_ProgressRange.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFDimTolObjects_DatumObject.hxx>
#include <XCAFDimTolObjects_DimensionObject.hxx>
#include <XCAFDimTolObjects_GeomToleranceObject.hxx>
#include <XCAFDoc_Datum.hxx>
#include <XCAFDoc_Dimension.hxx>
#include <XCAFDoc_DimTolTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_GeomTolerance.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

class LabDefeature {
public:
  static TopoDS_Shape Remove(const TopoDS_Shape& shape, const TopoDS_Shape& faces, bool parallel) {
    err() = "";
    try {
      BRepAlgoAPI_Defeaturing df;
      df.SetShape(shape);
      int n = 0;
      for (TopExp_Explorer ex(faces, TopAbs_FACE); ex.More(); ex.Next()) { df.AddFaceToRemove(ex.Current()); n++; }
      if (!n) { err() = "no faces to remove"; return TopoDS_Shape(); }
      df.SetRunParallel(parallel);
      df.SetToFillHistory(false);
      df.Build(Message_ProgressRange());
      if (df.HasErrors() || !df.IsDone()) { err() = "the faces could not be removed (their neighbours cannot be extended to close the gap)"; return TopoDS_Shape(); }
      if (df.HasWarnings()) err() = "warnings";
      return df.Shape();
    } catch (...) { err() = "the defeaturing failed"; return TopoDS_Shape(); }
  }
  static std::string LastError() { return err(); }

private:
  static std::string& err() { static std::string e; return e; }
};

class LabPMI {
  static std::vector<std::string> split(const std::string& s, char c) {
    std::vector<std::string> out;
    std::string cur;
    for (char ch : s) { if (ch == c) { out.push_back(cur); cur.clear(); } else cur += ch; }
    out.push_back(cur);
    return out;
  }
  static gp_Pnt pnt(const std::string& s) {
    double x = 0, y = 0, z = 0;
    std::istringstream is(s);
    is >> x >> y >> z;
    return gp_Pnt(x, y, z);
  }
  static double num(const std::string& s) { return std::strtod(s.c_str(), nullptr); }
  static std::string fmt(double v) { char b[40]; std::snprintf(b, sizeof b, "%.10g", v); return b; }
  static std::string fmt(const gp_Pnt& p) { return fmt(p.X()) + " " + fmt(p.Y()) + " " + fmt(p.Z()); }
  // (the face of `shape` nearest p)
  static TopoDS_Shape nearestFace(const TopoDS_Shape& shape, const gp_Pnt& p) {
    TopoDS_Shape best;
    double bd = 1e300;
    TopoDS_Shape v = BRepBuilderAPI_MakeVertex(p).Shape();
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
      BRepExtrema_DistShapeShape d(v, ex.Current());
      if (d.IsDone() && d.Value() < bd) { bd = d.Value(); best = ex.Current(); }
    }
    return best;
  }
  static XCAFDimTolObjects_GeomToleranceType gtType(const std::string& k) {
    static const std::map<std::string, XCAFDimTolObjects_GeomToleranceType> m = {
      {"angularity", XCAFDimTolObjects_GeomToleranceType_Angularity}, {"runout", XCAFDimTolObjects_GeomToleranceType_CircularRunout},
      {"circularity", XCAFDimTolObjects_GeomToleranceType_CircularityOrRoundness}, {"concentricity", XCAFDimTolObjects_GeomToleranceType_Concentricity},
      {"cylindricity", XCAFDimTolObjects_GeomToleranceType_Cylindricity}, {"flatness", XCAFDimTolObjects_GeomToleranceType_Flatness},
      {"parallelism", XCAFDimTolObjects_GeomToleranceType_Parallelism}, {"perpendicularity", XCAFDimTolObjects_GeomToleranceType_Perpendicularity},
      {"position", XCAFDimTolObjects_GeomToleranceType_Position}, {"profileLine", XCAFDimTolObjects_GeomToleranceType_ProfileOfLine},
      {"profileSurface", XCAFDimTolObjects_GeomToleranceType_ProfileOfSurface}, {"straightness", XCAFDimTolObjects_GeomToleranceType_Straightness},
      {"symmetry", XCAFDimTolObjects_GeomToleranceType_Symmetry}, {"totalRunout", XCAFDimTolObjects_GeomToleranceType_TotalRunout}};
    auto it = m.find(k);
    return it == m.end() ? XCAFDimTolObjects_GeomToleranceType_None : it->second;
  }
  static std::string gtName(XCAFDimTolObjects_GeomToleranceType t) {
    for (const char* k : {"angularity", "runout", "circularity", "concentricity", "cylindricity", "flatness", "parallelism", "perpendicularity", "position", "profileLine", "profileSurface", "straightness", "symmetry", "totalRunout"})
      if (gtType(k) == t) return k;
    return "other";
  }
  static gp_Pnt middle(const TopoDS_Shape& s) {
    Bnd_Box b;
    BRepBndLib::Add(s, b);
    if (b.IsVoid()) return gp_Pnt();
    double x0, y0, z0, x1, y1, z1;
    b.Get(x0, y0, z0, x1, y1, z1);
    return gp_Pnt((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }

public:
  static std::string WriteStep(const TopoDS_Shape& shape, const std::string& name, const std::string& spec) {
    occ::handle<TDocStd_Document> doc = new TDocStd_Document(TCollection_ExtendedString("XmlOcaf"));
    occ::handle<XCAFDoc_ShapeTool> st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    occ::handle<XCAFDoc_DimTolTool> dt = XCAFDoc_DocumentTool::DimTolTool(doc->Main());
    TDF_Label shapeL = st->AddShape(shape, false);
    TDataStd_Name::Set(shapeL, TCollection_ExtendedString(name.c_str(), true));
    std::map<std::string, TDF_Label> faceLabels;
    auto faceLabel = [&](const gp_Pnt& p) -> TDF_Label {
      TopoDS_Shape f = nearestFace(shape, p);
      if (f.IsNull()) return TDF_Label();
      TDF_Label l;
      if (!st->FindSubShape(shapeL, f, l)) l = st->AddSubShape(shapeL, f);
      return l;
    };
    std::map<std::string, TDF_Label> datums, datumFaces;
    std::vector<std::vector<std::string>> lines;
    for (const std::string& raw : split(spec, '\n')) if (!raw.empty()) lines.push_back(split(raw, '|'));
    // (datums first, so tolerances can refer to them)
    for (const auto& f : lines) {
      if (f.size() < 3 || f[0] != "D") continue;
      TDF_Label fl = faceLabel(pnt(f[2]));
      if (fl.IsNull()) continue;
      TDF_Label dl = dt->AddDatum();
      occ::handle<XCAFDoc_Datum> da = XCAFDoc_Datum::Set(dl);
      occ::handle<XCAFDimTolObjects_DatumObject> o = new XCAFDimTolObjects_DatumObject();
      o->SetName(new TCollection_HAsciiString(f[1].c_str()));
      da->SetObject(o);
      NCollection_Sequence<TDF_Label> seq;
      seq.Append(fl);
      dt->SetDatum(seq, dl);
      datums[f[1]] = dl;
      datumFaces[f[1]] = fl;
    }
    for (const auto& f : lines) {
      if (f[0] == "T" && f.size() >= 5) {
        TDF_Label fl = faceLabel(pnt(f[4]));
        if (fl.IsNull()) continue;
        TDF_Label gl = dt->AddGeomTolerance();
        occ::handle<XCAFDoc_GeomTolerance> ga = XCAFDoc_GeomTolerance::Set(gl);
        occ::handle<XCAFDimTolObjects_GeomToleranceObject> o = new XCAFDimTolObjects_GeomToleranceObject();
        o->SetType(gtType(f[1]));
        o->SetValue(num(f[2]));
        if (f[3] == "1") o->SetTypeOfValue(XCAFDimTolObjects_GeomToleranceTypeValue_Diameter);
        o->SetPoint(pnt(f[4]));
        ga->SetObject(o);
        dt->SetGeomTolerance(fl, gl);
        // (each datum referred to: a datum of its own for this tolerance, at its place in the frame (1 primary, 2
        // secondary, 3 tertiary), on the datum's face: the writer makes the datum system from those)
        if (f.size() >= 6) {
          int pos = 0;
          for (const std::string& d : split(f[5], ',')) {
            auto it = datumFaces.find(d);
            if (d.empty() || it == datumFaces.end()) continue;
            TDF_Label rl = dt->AddDatum();
            occ::handle<XCAFDoc_Datum> ra = XCAFDoc_Datum::Set(rl);
            occ::handle<XCAFDimTolObjects_DatumObject> ro = new XCAFDimTolObjects_DatumObject();
            ro->SetName(new TCollection_HAsciiString(d.c_str()));
            ro->SetPosition(++pos);
            ra->SetObject(ro);
            NCollection_Sequence<TDF_Label> seq;
            seq.Append(it->second);
            dt->SetDatum(seq, rl);
            dt->SetDatumToGeomTol(rl, gl);
          }
        }
      } else if (f[0] == "L" && f.size() >= 6) {
        const gp_Pnt p = pnt(f[4]), q = pnt(f[5]);
        TDF_Label a = faceLabel(p), b = faceLabel(q);
        if (a.IsNull() || b.IsNull()) continue;
        TDF_Label dl = dt->AddDimension();
        occ::handle<XCAFDoc_Dimension> da = XCAFDoc_Dimension::Set(dl);
        occ::handle<XCAFDimTolObjects_DimensionObject> o = new XCAFDimTolObjects_DimensionObject();
        o->SetType(XCAFDimTolObjects_DimensionType_Location_LinearDistance);
        o->SetValue(num(f[1]));
        const double up = num(f[2]), lo = num(f[3]);
        if (up != 0 || lo != 0) { o->SetUpperTolValue(up); o->SetLowerTolValue(-lo); }
        o->SetPoint(p);
        o->SetPoint2(q);
        if (f.size() >= 7) o->SetPointTextAttach(pnt(f[6]));
        da->SetObject(o);
        dt->SetDimension(a, b, dl);
      }
    }
    // (the writer first: making one sets the STEP parameters up, and would put back the schema set before it)
    STEPCAFControl_Writer w;
    Interface_Static::SetCVal("xstep.cascade.unit", "MM");
    Interface_Static::SetCVal("write.step.unit", "MM");
    Interface_Static::SetIVal("write.step.schema", 5);
    w.SetNameMode(true);
    w.SetDimTolMode(true);
    const char* path = "/lab-pmi-out.step";
    if (!w.Transfer(doc, STEPControl_AsIs)) return "";
    if (w.Write(path) != IFSelect_RetDone) return "";
    std::ifstream in(path, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    in.close();
    std::remove(path);
    return ss.str();
  }

  static std::string ReadStep(const std::string& text) {
    std::istringstream is(text);
    STEPCAFControl_Reader r;
    r.SetGDTMode(true);
    r.SetNameMode(true);
    if (r.ReadStream("pmi.step", is) != IFSelect_RetDone) return "";
    occ::handle<TDocStd_Document> doc = new TDocStd_Document(TCollection_ExtendedString("XmlOcaf"));
    if (!r.Transfer(doc)) return "";
    occ::handle<XCAFDoc_DimTolTool> dt = XCAFDoc_DocumentTool::DimTolTool(doc->Main());
    std::string out;
    auto ref = [&](const TDF_Label& l, bool second) -> gp_Pnt {
      NCollection_Sequence<TDF_Label> a, b;
      XCAFDoc_DimTolTool::GetRefShapeLabel(l, a, b);
      const NCollection_Sequence<TDF_Label>& s = second ? b : a;
      return s.Length() ? middle(XCAFDoc_ShapeTool::GetShape(s.Value(1))) : gp_Pnt();
    };
    NCollection_Sequence<TDF_Label> ls;
    dt->GetDatumLabels(ls);
    for (int i = 1; i <= ls.Length(); i++) {
      occ::handle<XCAFDoc_Datum> a;
      if (!ls.Value(i).FindAttribute(XCAFDoc_Datum::GetID(), a)) continue;
      occ::handle<XCAFDimTolObjects_DatumObject> o = a->GetObject();
      out += "D|" + std::string(o.IsNull() || o->GetName().IsNull() ? "" : o->GetName()->ToCString()) + "|" + fmt(ref(ls.Value(i), false)) + "\n";
    }
    ls.Clear();
    dt->GetGeomToleranceLabels(ls);
    for (int i = 1; i <= ls.Length(); i++) {
      occ::handle<XCAFDoc_GeomTolerance> a;
      if (!ls.Value(i).FindAttribute(XCAFDoc_GeomTolerance::GetID(), a)) continue;
      occ::handle<XCAFDimTolObjects_GeomToleranceObject> o = a->GetObject();
      if (o.IsNull()) continue;
      std::string ds;
      NCollection_Sequence<TDF_Label> dls;
      if (dt->GetDatumOfTolerLabels(ls.Value(i), dls)) for (int k = 1; k <= dls.Length(); k++) {
        occ::handle<XCAFDoc_Datum> da;
        if (dls.Value(k).FindAttribute(XCAFDoc_Datum::GetID(), da) && !da->GetObject().IsNull() && !da->GetObject()->GetName().IsNull()) ds += (ds.empty() ? "" : ",") + std::string(da->GetObject()->GetName()->ToCString());
      }
      out += "T|" + gtName(o->GetType()) + "|" + fmt(o->GetValue()) + "|" + (o->GetTypeOfValue() == XCAFDimTolObjects_GeomToleranceTypeValue_Diameter ? "1" : "0") + "|" + fmt(o->HasPoint() ? o->GetPoint() : ref(ls.Value(i), false)) + "|" + ds + "\n";
    }
    ls.Clear();
    dt->GetDimensionLabels(ls);
    for (int i = 1; i <= ls.Length(); i++) {
      occ::handle<XCAFDoc_Dimension> a;
      if (!ls.Value(i).FindAttribute(XCAFDoc_Dimension::GetID(), a)) continue;
      occ::handle<XCAFDimTolObjects_DimensionObject> o = a->GetObject();
      if (o.IsNull()) continue;
      out += "L|" + fmt(o->GetValue()) + "|" + fmt(o->GetUpperTolValue()) + "|" + fmt(-o->GetLowerTolValue()) + "|" + fmt(o->HasPoint() ? o->GetPoint() : ref(ls.Value(i), false)) + "|" + fmt(o->HasPoint2() ? o->GetPoint2() : ref(ls.Value(i), true)) + "|" + fmt(o->GetPointTextAttach()) + "\n";
    }
    return out;
  }
};

// Kernel Lab (k3): what RazorCAD's meshPart reads from every face and edge of a body, for many bodies at once and
// in parallel, with the same OpenCascade calls in the same order as its JavaScript (kernel.worker.js: surfOf,
// seamEdges, edgeKept / sampleEdge / curvePoints / circleOf; replicad's Shape.faces / .edges, Face.geomType /
// .center / .normalAt, Edge.geomType / .length), so the numbers are the same to the last bit. What the JavaScript
// does after (unit vectors, the objects) stays in JavaScript.
//
//   LabShapeInfo::facesAndEdges(bodies, diag, parallel): `bodies` a compound of bodies (its direct children);
//   diag: the sampling size (meshPart's diagQ). For each body, its faces in replicad's order (explorer order, each
//   face once: IsSame) and its edges likewise, seams left out (an edge met twice in one non-planar face).
//
//   LabShapeInfo::quickBoxes(faces, parallel): (k10) faces' quick boxes (BRepBndLib::Add), for findFaceAny.
//
// LabShapeData: two malloc'd arrays read from JavaScript.
//   ints:    [nBodies, then per body: nFaces, nEdges,
//             then per face: kind (0 PLANE, 1 CYLINDER, 2 CONE, 3 SPHERE, 4 OTHER, 5 TORUS (k8)),
//             then per edge: curve type (GeomAbs_CurveType; -1: work it out in JavaScript), has circle (0/1), points]
//   doubles: per face 8 (k8; 7 before: the 8th a torus's minor radius) (PLANE: centre, normal as BRepGProp_Face gives it, 0; CYLINDER / CONE: axis location,
//             axis direction, radius (a cone's reference radius); SPHERE: centre, 0, 0, 0, radius; OTHER: zeros),
//             then per edge: circle 7 (radius, centre, axis direction; zeros without), middle point 3, points 3 each.

#include <BRepAdaptor_Curve.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <gp_Torus.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <OSD_Parallel.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Iterator.hxx>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <vector>

class LabShapeInfo;

class LabShapeData {
public:
  LabShapeData() : doublesPtr_(nullptr), intsPtr_(nullptr), doublesSize_(0), intsSize_(0) {}
  ~LabShapeData() { std::free(doublesPtr_); std::free(intsPtr_); }
  LabShapeData(const LabShapeData& other)
    : doublesPtr_(other.doublesPtr_), intsPtr_(other.intsPtr_), doublesSize_(other.doublesSize_), intsSize_(other.intsSize_) {
    auto& moved = const_cast<LabShapeData&>(other);
    moved.doublesPtr_ = nullptr;
    moved.intsPtr_ = nullptr;
  }
  int getDoublesPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(doublesPtr_)); }
  int getDoublesSize() const { return doublesSize_; }
  int getIntsPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(intsPtr_)); }
  int getIntsSize() const { return intsSize_; }

private:
  double* doublesPtr_;
  int32_t* intsPtr_;
  int doublesSize_;
  int intsSize_;
  friend class LabShapeInfo;
};

class LabShapeInfo {
public:
  // (k6) each body's volume and area by adaptive integration (the default fixed rule can be percents off on trimmed
  // faces): for the direct children of `bodies` (a compound), volume as the app's preciseVolume does it for free-form
  // bodies (BRepGProp::VolumePropertiesGK(body, props, eps, false, true, false, false, false), absolute value) and area
  // by BRepGProp::SurfaceProperties(body, props, eps, false); in parallel with threads.
  // doubles: per body 2: volume, area (NaN where it failed).
  static LabShapeData solidProps(const TopoDS_Shape& bodies, double eps, bool parallel) {
    std::vector<TopoDS_Shape> list;
    for (TopoDS_Iterator it(bodies); it.More(); it.Next()) list.push_back(it.Value());
    const int n = static_cast<int>(list.size());
    LabShapeData out;
    out.doublesSize_ = n * 2;
    out.intsSize_ = 0;
    out.doublesPtr_ = static_cast<double*>(std::malloc(std::max(n * 2, 1) * sizeof(double)));
    out.intsPtr_ = static_cast<int32_t*>(std::malloc(sizeof(int32_t)));
    if (!out.doublesPtr_ || !out.intsPtr_) throw std::bad_alloc();
    double* D = out.doublesPtr_;
    const double nan = std::numeric_limits<double>::quiet_NaN();
    auto one = [&](const int i) {
      D[i * 2] = nan; D[i * 2 + 1] = nan;
      try { GProp_GProps p; BRepGProp::VolumePropertiesGK(list[i], p, eps, false, true, false, false, false); D[i * 2] = std::abs(p.Mass()); } catch (...) {}
      try { GProp_GProps p; BRepGProp::SurfaceProperties(list[i], p, eps, false); D[i * 2 + 1] = p.Mass(); } catch (...) {}
    };
    const bool threads = parallel && ReplicadConfigureThreadPool() > 1;
    OSD_Parallel::For(0, n, one, !threads);
    return out;
  }

  // (k5) each face's precise box, as the app's faceBox makes it (BRepBndLib::AddOptimal(face, box, false, false)),
  // for the faces of `faces` (a compound) in explorer order, each as met; in parallel with threads.
  // doubles: per face 7: 1 (0 when the box is void), xmin, ymin, zmin, xmax, ymax, zmax.
  static LabShapeData faceBoxes(const TopoDS_Shape& faces, bool parallel) {
    std::vector<TopoDS_Face> list;
    for (TopExp_Explorer ex(faces, TopAbs_FACE); ex.More(); ex.Next()) list.push_back(TopoDS::Face(ex.Current()));
    const int n = static_cast<int>(list.size());
    LabShapeData out;
    out.doublesSize_ = n * 7;
    out.intsSize_ = 0;
    out.doublesPtr_ = static_cast<double*>(std::malloc(std::max(n * 7, 1) * sizeof(double)));
    out.intsPtr_ = static_cast<int32_t*>(std::malloc(sizeof(int32_t)));
    if (!out.doublesPtr_ || !out.intsPtr_) throw std::bad_alloc();
    double* D = out.doublesPtr_;
    auto one = [&](const int i) {
      double* d = D + i * 7;
      for (int k = 0; k < 7; k++) d[k] = 0;
      try {
        Bnd_Box box;
        BRepBndLib::AddOptimal(list[i], box, false, false);
        if (!box.IsVoid()) {
          const gp_Pnt lo = box.CornerMin(), hi = box.CornerMax();
          d[0] = 1; d[1] = lo.X(); d[2] = lo.Y(); d[3] = lo.Z(); d[4] = hi.X(); d[5] = hi.Y(); d[6] = hi.Z();
        }
      } catch (...) { d[0] = -1; }
    };
    const bool threads = parallel && ReplicadConfigureThreadPool() > 1;
    OSD_Parallel::For(0, n, one, !threads);
    return out;
  }

  // (k10) each face's quick box, as the app's labQuickBox makes it: for the surface kinds whose usual box holds the
  // face (plane, cylinder, cone, sphere, torus, Bezier and B-spline patches) BRepBndLib::Add(face, box, false); for the
  // faces of `faces` (a compound) in explorer order, each as met; in parallel with threads.
  // doubles: per face 7: 1 (0 when the box is void, 2 for another surface kind: no box), xmin, ymin, zmin, xmax, ymax, zmax.
  static LabShapeData quickBoxes(const TopoDS_Shape& faces, bool parallel) {
    std::vector<TopoDS_Face> list;
    for (TopExp_Explorer ex(faces, TopAbs_FACE); ex.More(); ex.Next()) list.push_back(TopoDS::Face(ex.Current()));
    const int n = static_cast<int>(list.size());
    LabShapeData out;
    out.doublesSize_ = n * 7;
    out.intsSize_ = 0;
    out.doublesPtr_ = static_cast<double*>(std::malloc(std::max(n * 7, 1) * sizeof(double)));
    out.intsPtr_ = static_cast<int32_t*>(std::malloc(sizeof(int32_t)));
    if (!out.doublesPtr_ || !out.intsPtr_) throw std::bad_alloc();
    double* D = out.doublesPtr_;
    auto one = [&](const int i) {
      double* d = D + i * 7;
      for (int k = 0; k < 7; k++) d[k] = 0;
      try {
        const GeomAbs_SurfaceType type = BRepAdaptor_Surface(list[i], false).GetType();
        const bool sure = type == GeomAbs_Plane || type == GeomAbs_Cylinder || type == GeomAbs_Cone || type == GeomAbs_Sphere
          || type == GeomAbs_Torus || type == GeomAbs_BezierSurface || type == GeomAbs_BSplineSurface;
        if (!sure) { d[0] = 2; return; }
        Bnd_Box box;
        BRepBndLib::Add(list[i], box, false);
        if (!box.IsVoid()) {
          const gp_Pnt lo = box.CornerMin(), hi = box.CornerMax();
          d[0] = 1; d[1] = lo.X(); d[2] = lo.Y(); d[3] = lo.Z(); d[4] = hi.X(); d[5] = hi.Y(); d[6] = hi.Z();
        }
      } catch (...) { d[0] = -1; }
    };
    const bool threads = parallel && ReplicadConfigureThreadPool() > 1;
    OSD_Parallel::For(0, n, one, !threads);
    return out;
  }

  static LabShapeData facesAndEdges(const TopoDS_Shape& bodies, double diag, bool parallel) {
    struct FaceTask { TopoDS_Face face; int kind = 4; double d[8] = {0, 0, 0, 0, 0, 0, 0, 0}; };
    struct EdgeTask { TopoDS_Edge edge; int type = -1; int circ = 0; double c[7] = {0, 0, 0, 0, 0, 0, 0}; double mid[3] = {0, 0, 0}; std::vector<double> pts; };
    std::vector<FaceTask> faces;
    std::vector<EdgeTask> edges;
    std::vector<int> counts;  // per body: faces, edges
    for (TopoDS_Iterator it(bodies); it.More(); it.Next()) {
      const TopoDS_Shape& body = it.Value();
      TopTools_IndexedMapOfShape fmap, emap;
      TopExp::MapShapes(body, TopAbs_FACE, fmap);
      TopExp::MapShapes(body, TopAbs_EDGE, emap);
      // seams (seamEdges): in a face that is not a plane, an edge met a second time
      TopTools_MapOfShape seams;
      for (int i = 1; i <= fmap.Extent(); i++) {
        const TopoDS_Face& face = TopoDS::Face(fmap(i));
        if (BRepAdaptor_Surface(face, false).GetType() == GeomAbs_Plane) continue;
        std::vector<TopoDS_Shape> seen;
        for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
          const TopoDS_Shape& e = ex.Current();
          bool again = false;
          for (const TopoDS_Shape& s : seen) if (s.IsSame(e)) { again = true; break; }
          if (again) seams.Add(e); else seen.push_back(e);
        }
      }
      int ne = 0;
      for (int i = 1; i <= fmap.Extent(); i++) { FaceTask t; t.face = TopoDS::Face(fmap(i)); faces.push_back(t); }
      for (int i = 1; i <= emap.Extent(); i++) {
        if (seams.Contains(emap(i))) continue;
        EdgeTask t; t.edge = TopoDS::Edge(emap(i)); edges.push_back(t); ne++;
      }
      counts.push_back(fmap.Extent());
      counts.push_back(ne);
    }

    const int nf = static_cast<int>(faces.size()), nE = static_cast<int>(edges.size());
    auto doFace = [&](const int i) {
      FaceTask& t = faces[i];
      try {
        const GeomAbs_SurfaceType type = BRepAdaptor_Surface(t.face, false).GetType();
        if (type == GeomAbs_Plane) {
          // (k12) the centre as RazorCAD's flatCentre makes it: the plain integration, SurfaceProperties(face, props,
          // false, false); for a face of no area (|mass| not above 1e-12) replicad's Face.center, the adaptive
          // SurfaceProperties(face, props, 1e-7, true). normalAt(): BRepGProp_Face at the middle of the UV bounds
          GProp_GProps props;
          BRepGProp::SurfaceProperties(t.face, props, false, false);
          gp_Pnt c = props.CentreOfMass();
          if (!(std::abs(props.Mass()) > 1e-12)) {
            GProp_GProps exact;
            BRepGProp::SurfaceProperties(t.face, exact, 1e-7, true);
            c = exact.CentreOfMass();
          }
          Standard_Real u0, u1, v0, v1;
          BRepTools::UVBounds(t.face, u0, u1, v0, v1);
          const double u = 0.5 * (u0 + u1), v = 0.5 * (v0 + v1);
          gp_Pnt p;
          gp_Vec n;
          BRepGProp_Face(t.face, false).Normal(u, v, p, n);
          const double d[7] = {c.X(), c.Y(), c.Z(), n.X(), n.Y(), n.Z(), 0};
          for (int k = 0; k < 7; k++) t.d[k] = d[k];
          t.kind = 0;
        } else if (type == GeomAbs_Torus) {
          // (k8) a torus: axis location, axis direction, major radius, minor radius
          BRepAdaptor_Surface ad(t.face, true);
          const gp_Torus tr = ad.Torus();
          const gp_Ax1 axis = tr.Axis();
          const gp_Pnt L = axis.Location();
          const gp_Dir D = axis.Direction();
          const double d[8] = {L.X(), L.Y(), L.Z(), D.X(), D.Y(), D.Z(), tr.MajorRadius(), tr.MinorRadius()};
          for (int k = 0; k < 8; k++) t.d[k] = d[k];
          t.kind = 5;
        } else if (type == GeomAbs_Cylinder || type == GeomAbs_Cone || type == GeomAbs_Sphere) {
          BRepAdaptor_Surface ad(t.face, true);
          if (type == GeomAbs_Sphere) {
            const gp_Sphere s = ad.Sphere();
            const gp_Pnt L = s.Location();
            const double d[7] = {L.X(), L.Y(), L.Z(), 0, 0, 0, s.Radius()};
            for (int k = 0; k < 7; k++) t.d[k] = d[k];
            t.kind = 3;
          } else {
            gp_Ax1 axis;
            double r;
            if (type == GeomAbs_Cylinder) { const gp_Cylinder c = ad.Cylinder(); axis = c.Axis(); r = c.Radius(); t.kind = 1; }
            else { const gp_Cone c = ad.Cone(); axis = c.Axis(); r = c.RefRadius(); t.kind = 2; }
            const gp_Pnt L = axis.Location();
            const gp_Dir D = axis.Direction();
            const double d[7] = {L.X(), L.Y(), L.Z(), D.X(), D.Y(), D.Z(), r};
            for (int k = 0; k < 7; k++) t.d[k] = d[k];
          }
        }
      } catch (...) {
        t.kind = 4;
        for (int k = 0; k < 8; k++) t.d[k] = 0;
      }
    };
    auto doEdge = [&](const int i) {
      EdgeTask& t = edges[i];
      try {
        BRepAdaptor_Curve c(t.edge);
        const GeomAbs_CurveType type = c.GetType();
        const double u0 = c.FirstParameter(), u1 = c.LastParameter();
        // sampleEdge: a line by its two ends; others at i/n of the range, n from the edge's length
        int n;
        bool ends = false;
        if (type == GeomAbs_Line) { n = 1; ends = true; }
        else {
          GProp_GProps props;
          BRepGProp::LinearProperties(t.edge, props, true, false);
          const double L = props.Mass();
          const int nMin = (type == GeomAbs_BSplineCurve || type == GeomAbs_BezierCurve || type == GeomAbs_OtherCurve) ? 160 : 24;
          // (as JavaScript's Math.max / Math.min / Math.ceil, NaN included: then no points)
          const double q = std::ceil(L / std::max(diag * 0.004, 0.05));
          const double m = std::isnan(q) ? q : std::min(128.0, q);
          const double nn = std::isnan(m) ? m : std::max(static_cast<double>(nMin), m);
          n = std::isnan(nn) ? -1 : static_cast<int>(nn);
        }
        t.pts.reserve(n >= 0 ? (n + 1) * 3 : 0);
        for (int k = 0; k <= n; k++) {
          const gp_Pnt p = c.Value(ends && k == n ? u1 : u0 + (u1 - u0) * (static_cast<double>(k) / static_cast<double>(n)));
          t.pts.push_back(p.X()); t.pts.push_back(p.Y()); t.pts.push_back(p.Z());
        }
        // the middle point: curvePoints(e, 2)[1]
        const gp_Pnt m = c.Value(u0 + (u1 - u0) * (1.0 / 2.0));
        t.mid[0] = m.X(); t.mid[1] = m.Y(); t.mid[2] = m.Z();
        // circleOf: from its own adaptor, as there
        if (type == GeomAbs_Circle) {
          try {
            BRepAdaptor_Curve ad(t.edge);
            const gp_Circ ci = ad.Circle();
            const gp_Pnt L = ci.Location();
            const gp_Dir D = ci.Axis().Direction();
            const double cc[7] = {ci.Radius(), L.X(), L.Y(), L.Z(), D.X(), D.Y(), D.Z()};
            for (int k = 0; k < 7; k++) t.c[k] = cc[k];
            t.circ = 1;
          } catch (...) { t.circ = 0; }
        }
        t.type = static_cast<int>(type);
      } catch (...) {
        t.type = -1;
        t.pts.clear();
      }
    };
    const bool threads = parallel && ReplicadConfigureThreadPool() > 1;
    OSD_Parallel::For(0, nf, doFace, !threads);
    OSD_Parallel::For(0, nE, doEdge, !threads);

    // packed
    int nd = nf * 8, ni = 1 + static_cast<int>(counts.size()) + nf + nE * 3;
    for (const EdgeTask& t : edges) nd += 10 + static_cast<int>(t.pts.size());
    LabShapeData out;
    out.doublesSize_ = nd;
    out.intsSize_ = ni;
    out.doublesPtr_ = static_cast<double*>(std::malloc(std::max(nd, 1) * sizeof(double)));
    out.intsPtr_ = static_cast<int32_t*>(std::malloc(std::max(ni, 1) * sizeof(int32_t)));
    if (!out.doublesPtr_ || !out.intsPtr_) throw std::bad_alloc();
    int di = 0, ii = 0;
    out.intsPtr_[ii++] = static_cast<int32_t>(counts.size() / 2);
    for (int c : counts) out.intsPtr_[ii++] = c;
    for (const FaceTask& t : faces) {
      out.intsPtr_[ii++] = t.kind;
      for (int k = 0; k < 8; k++) out.doublesPtr_[di++] = t.d[k];
    }
    for (const EdgeTask& t : edges) {
      out.intsPtr_[ii++] = t.type;
      out.intsPtr_[ii++] = t.circ;
      out.intsPtr_[ii++] = static_cast<int32_t>(t.pts.size() / 3);
      for (int k = 0; k < 7; k++) out.doublesPtr_[di++] = t.c[k];
      for (int k = 0; k < 3; k++) out.doublesPtr_[di++] = t.mid[k];
      for (double x : t.pts) out.doublesPtr_[di++] = x;
    }
    return out;
  }
};

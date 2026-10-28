// Kernel Lab (k2): meshing many bodies in one call, and extracting the triangles without meshing again.
//
// replicad's ReplicadMeshExtractor::extract cleans and meshes the shape it is given every time, then extracts its
// faces one after another. RazorCAD meshes body by body (only the faces a feature changed), so with threads each
// call has few faces to share out, and meshing first in one parallel call gained nothing (extract meshed again).
//
//   LabMeshExtractor::mesh(shape, tol, angTol)          clean, then mesh everything given in ONE BRepMesh call, in
//                                                        parallel when the build has threads. Returns the threads.
//   LabMeshExtractor::extract(shape, skipNormals, par)  the triangulation already on the faces, packed exactly as
//                                                        ReplicadExtractFaceMesh packs it (same arrays, same order,
//                                                        same arithmetic), faces filled in parallel when par is
//                                                        true and the build has threads. Faces without a
//                                                        triangulation are skipped, as there.
//
// LabMeshData: the same four malloc'd arrays and getters as ReplicadMeshData (read the same way from JavaScript).

#include <BRepAdaptor_Surface.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <OSD_Parallel.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Iterator.hxx>
#include <BRep_Builder.hxx>
#include <set>
#include <cstdlib>
#include <vector>

class LabMeshExtractor;

class LabMeshData {
public:
  LabMeshData()
    : verticesPtr_(nullptr), normalsPtr_(nullptr), trianglesPtr_(nullptr), faceGroupsPtr_(nullptr),
      verticesSize_(0), normalsSize_(0), trianglesSize_(0), faceGroupsSize_(0) {}
  ~LabMeshData() {
    std::free(verticesPtr_);
    std::free(normalsPtr_);
    std::free(trianglesPtr_);
    std::free(faceGroupsPtr_);
  }
  // (moves, as ReplicadMeshData's copy does: embind copies the return value)
  LabMeshData(const LabMeshData& other)
    : verticesPtr_(other.verticesPtr_), normalsPtr_(other.normalsPtr_), trianglesPtr_(other.trianglesPtr_),
      faceGroupsPtr_(other.faceGroupsPtr_), verticesSize_(other.verticesSize_), normalsSize_(other.normalsSize_),
      trianglesSize_(other.trianglesSize_), faceGroupsSize_(other.faceGroupsSize_) {
    auto& moved = const_cast<LabMeshData&>(other);
    moved.verticesPtr_ = nullptr;
    moved.normalsPtr_ = nullptr;
    moved.trianglesPtr_ = nullptr;
    moved.faceGroupsPtr_ = nullptr;
  }

  int getVerticesPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(verticesPtr_)); }
  int getNormalsPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(normalsPtr_)); }
  int getTrianglesPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(trianglesPtr_)); }
  int getFaceGroupsPtr() const { return static_cast<int>(reinterpret_cast<uintptr_t>(faceGroupsPtr_)); }
  int getVerticesSize() const { return verticesSize_; }
  int getNormalsSize() const { return normalsSize_; }
  int getTrianglesSize() const { return trianglesSize_; }
  int getFaceGroupsSize() const { return faceGroupsSize_; }

private:
  float* verticesPtr_;
  float* normalsPtr_;
  uint32_t* trianglesPtr_;
  int32_t* faceGroupsPtr_;
  int verticesSize_;
  int normalsSize_;
  int trianglesSize_;
  int faceGroupsSize_;
  friend class LabMeshExtractor;
};

class LabMeshExtractor {
public:
  static int mesh(const TopoDS_Shape& shape, double tolerance, double angularTolerance) {
    BRepTools::Clean(shape, false);
    const int threads = ReplicadConfigureThreadPool();
    BRepMesh_IncrementalMesh mesher(shape, tolerance, false, angularTolerance, threads > 1);
    return threads;
  }

  // (k7) the direct children of `groups` (a compound: e.g. each body's faces to mesh, as a compound of its own) meshed
  // each on its own and one thread each, the children shared out over the threads: bodies share no edges, so each
  // face comes out as when everything is meshed in one call, while the edge work runs in parallel too. A face shared
  // by several children (the same underlying face: instances of one part in an import, at different places) is meshed
  // in the first child that has it only, so no two threads ever mesh the same face. Returns the threads used.
  static int meshBodies(const TopoDS_Shape& groups, double tolerance, double angularTolerance) {
    std::vector<TopoDS_Compound> list;
    std::set<const void*> taken;
    BRep_Builder builder;
    for (TopoDS_Iterator it(groups); it.More(); it.Next()) {
      TopoDS_Compound c;
      builder.MakeCompound(c);
      int n = 0;
      for (TopExp_Explorer ex(it.Value(), TopAbs_FACE); ex.More(); ex.Next()) {
        const void* ts = ex.Current().TShape().get();
        if (!taken.insert(ts).second) continue;
        builder.Add(c, ex.Current());
        n++;
      }
      if (n) list.push_back(c);
    }
    const int threads = ReplicadConfigureThreadPool();
    auto one = [&](const int i) {
      BRepTools::Clean(list[i], false);
      BRepMesh_IncrementalMesh mesher(list[i], tolerance, false, angularTolerance, false);
    };
    OSD_Parallel::For(0, static_cast<int>(list.size()), one, threads <= 1);
    return threads;
  }

  static LabMeshData extract(const TopoDS_Shape& shape, bool skipNormals, bool parallel) {
    // the faces with a triangulation, in the explorer's order, and where each one's data starts
    struct Face {
      TopoDS_Face face;
      Handle(Poly_Triangulation) tri;
      TopLoc_Location location;
      int node0, tri0;
    };
    std::vector<Face> faces;
    int totalNodes = 0, totalTriangles = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
      Face f;
      f.face = TopoDS::Face(explorer.Current());
      f.tri = BRep_Tool::Triangulation(f.face, f.location);
      if (f.tri.IsNull()) continue;
      f.node0 = totalNodes;
      f.tri0 = totalTriangles;
      totalNodes += f.tri->NbNodes();
      totalTriangles += f.tri->NbTriangles();
      faces.push_back(f);
    }

    LabMeshData result;
    result.verticesSize_ = totalNodes * 3;
    result.verticesPtr_ = static_cast<float*>(std::malloc(result.verticesSize_ * sizeof(float)));
    if (!result.verticesPtr_ && result.verticesSize_ > 0) throw std::bad_alloc();
    if (!skipNormals) {
      result.normalsSize_ = totalNodes * 3;
      result.normalsPtr_ = static_cast<float*>(std::malloc(result.normalsSize_ * sizeof(float)));
      if (!result.normalsPtr_ && result.normalsSize_ > 0) throw std::bad_alloc();
    }
    result.trianglesSize_ = totalTriangles * 3;
    result.trianglesPtr_ = static_cast<uint32_t*>(std::malloc(result.trianglesSize_ * sizeof(uint32_t)));
    if (!result.trianglesPtr_ && result.trianglesSize_ > 0) throw std::bad_alloc();
    result.faceGroupsSize_ = static_cast<int>(faces.size()) * 3;
    result.faceGroupsPtr_ = static_cast<int32_t*>(std::malloc(result.faceGroupsSize_ * sizeof(int32_t)));
    if (!result.faceGroupsPtr_ && result.faceGroupsSize_ > 0) throw std::bad_alloc();

    float* V = result.verticesPtr_;
    float* N = result.normalsPtr_;
    uint32_t* T = result.trianglesPtr_;
    int32_t* G = result.faceGroupsPtr_;
    // one face: the same steps as ReplicadExtractFaceMesh's loop body, into its own slice of the arrays
    auto fill = [&](const int i) {
      const Face& f = faces[i];
      const TopoDS_Face& face = f.face;
      const Handle(Poly_Triangulation)& triangulation = f.tri;
      const gp_Trsf& transformation = f.location.Transformation();
      const int nodeCount = triangulation->NbNodes();
      const int triangleCount = triangulation->NbTriangles();
      const int vertexOffset = f.node0;
      for (int index = 1; index <= nodeCount; index++) {
        const gp_Pnt point = triangulation->Node(index).Transformed(transformation);
        const int base = (vertexOffset + index - 1) * 3;
        V[base] = static_cast<float>(point.X());
        V[base + 1] = static_cast<float>(point.Y());
        V[base + 2] = static_cast<float>(point.Z());
      }
      const bool isReversed = face.Orientation() == TopAbs_REVERSED;
      if (!skipNormals) {
        TopoDS_Face forwardFace = TopoDS::Face(face.Oriented(TopAbs_FORWARD));
        forwardFace.Location(TopLoc_Location());
        TopLoc_Location surfaceLocation;
        const bool hasSurface = !BRep_Tool::Surface(forwardFace, surfaceLocation).IsNull();
        if (hasSurface) {
          BRepAdaptor_Surface adaptor(forwardFace, false);
          BRepLProp_SLProps properties(adaptor, 1, 1e-12);
          for (int index = 1; index <= nodeCount; index++) {
            gp_Dir normal(0, 0, 1);
            if (triangulation->HasUVNodes()) {
              const gp_Pnt2d uv = triangulation->UVNode(index);
              properties.SetParameters(uv.X(), uv.Y());
              if (properties.IsNormalDefined()) normal = properties.Normal();
            }
            normal.Transform(transformation);
            if (isReversed) normal.Reverse();
            const int base = (vertexOffset + index - 1) * 3;
            N[base] = static_cast<float>(normal.X());
            N[base + 1] = static_cast<float>(normal.Y());
            N[base + 2] = static_cast<float>(normal.Z());
          }
        } else {
          for (int index = 1; index <= nodeCount; index++) {
            const int base = (vertexOffset + index - 1) * 3;
            N[base] = 0.0f;
            N[base + 1] = 0.0f;
            N[base + 2] = 1.0f;
          }
        }
      }
      const bool isMirrored = transformation.VectorialPart().Determinant() < 0.0;
      int t = f.tri0 * 3;
      const int faceTriangleStart = t;
      for (int index = 1; index <= triangleCount; index++) {
        const Poly_Triangle& triangle = triangulation->Triangle(index);
        int first = triangle.Value(1), second = triangle.Value(2), third = triangle.Value(3);
        if (isReversed ^ isMirrored) std::swap(second, third);
        T[t] = static_cast<uint32_t>(first - 1 + vertexOffset);
        T[t + 1] = static_cast<uint32_t>(second - 1 + vertexOffset);
        T[t + 2] = static_cast<uint32_t>(third - 1 + vertexOffset);
        t += 3;
      }
      G[i * 3] = faceTriangleStart;
      G[i * 3 + 1] = t - faceTriangleStart;
      G[i * 3 + 2] = ReplicadShapeHashCode(face, ReplicadShapeHashUpperBound);
    };
    const bool threads = parallel && ReplicadConfigureThreadPool() > 1;
    OSD_Parallel::For(0, static_cast<int>(faces.size()), fill, !threads);
    return result;
  }
};

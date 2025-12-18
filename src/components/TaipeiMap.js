"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import Polygon from "ol/geom/Polygon";
import LineString from "ol/geom/LineString";
import Heatmap from "ol/layer/Heatmap";
import { fromLonLat, toLonLat } from "ol/proj";
import { Style, Stroke, Fill, Circle as CircleStyle } from "ol/style";
import { defaults as defaultControls } from "ol/control";

// Components
import LayerSwitcher from "./LayerSwitcher";
import MapModeSelector from "./MapModeSelector";

// Libraries
import { getTownPassClient } from "@/lib/townpass/client";
import { useTownPass } from "@/lib/townpass/hooks/useTownPass";

// Configs
import weightConfig from "@/configs/weightConfig.json";

export default function MapComponent() {
  const searchParams = useSearchParams();
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const positionFeatureRef = useRef(null);
  const directionFeatureRef = useRef(null);
  const markersLayerRef = useRef(null);
  const isInitializedRef = useRef(false);

  const [layers, setLayers] = useState({});
  const [layerVisibility, setLayerVisibility] = useState({});
  const [map, setMap] = useState(null);
  const [view, setView] = useState(null);
  const [position, setPosition] = useState(null);
  const [orientation, setOrientation] = useState(null);
  const [currentMode, setCurrentMode] = useState("bicycle");
  const [center, setCenter] = useState(null);

  const { setMode } = useTownPass();

  // 監聽模式變化
  useEffect(() => {
    setMode(currentMode)
      .then(() => {
        console.log("TaipeiMap: Mode changed to", currentMode);
      })
      .catch((error) => {
        console.error("Failed to change mode:", error);
      });
  }, [currentMode]);

  useEffect(() => {
    if (!mapRef.current) return;

    // 讀取 URL 參數
    const latParam = searchParams.get("lat");
    const lonParam = searchParams.get("lon");
    const zoomParam = searchParams.get("zoom");

    // 設定預設值（若參數不存在或格式錯誤）
    const lat = latParam ? parseFloat(latParam) : 23.5;
    const lon = lonParam ? parseFloat(lonParam) : 121.0;
    const zoom = zoomParam ? parseFloat(zoomParam) : 18;

    const initialView = new View({
      center: fromLonLat([lon, lat]),
      zoom,
    });

    const baseLayer = new TileLayer({
      source: new XYZ({
        url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        attributions: "© OpenStreetMap © CARTO",
      }),
    });

    const mapObj = new Map({
      target: mapRef.current,
      layers: [baseLayer],
      view: initialView,
      controls: defaultControls({ zoom: false }),
    });

    mapObj.on("moveend", () => {
      const center = toLonLat(mapObj.getView().getCenter());
      setCenter(center);
    });

    mapInstanceRef.current = mapObj;
    setMap(mapObj);
    setView(initialView);

    navigator.geolocation.getCurrentPosition((pos) => {
      const coords = fromLonLat([pos.coords.longitude, pos.coords.latitude]);

      setPosition(coords);

      if (positionFeatureRef.current) {
        positionFeatureRef.current.setGeometry(new Point(coords));
      }

      if (!searchParams.get("lon") || !searchParams.get("lat")) {
        initialView.setCenter(coords);
      }
    });

    // === 載入位置圖層 ===
    loadPositionLayer().then((positionLayer) => {
      mapObj.addLayer(positionLayer);
    });

    // === 載入 API 線段資料 ===
    loadLinesLayer().then(([bikeVectorLayer, sidewalkVectorLayer]) => {
      mapObj.addLayer(bikeVectorLayer);
      mapObj.addLayer(sidewalkVectorLayer);
      setLayers((prev) => ({
        ...prev,
        bike: bikeVectorLayer,
        sidewalk: sidewalkVectorLayer,
      }));
      bikeVectorLayer.set("displayName", "自行車道");
      sidewalkVectorLayer.set("displayName", "人行道");
    });

    // === 載入事故圖層 ===
    loadAccidentLayer().then((accidentLayer) => {
      mapObj.addLayer(accidentLayer);
      setLayers((prev) => ({ ...prev, accident: accidentLayer }));
      accidentLayer.set("displayName", "事故熱點");

      // 根據 zoom 調整熱力圖細節
      const view = mapObj.getView();
      view.on("change:resolution", () => {
        const zoom = view.getZoom();

        const radius = Math.max(5, (zoom - 10) * 2); // zoom=18 時 ≈16px
        const blur = radius * 1.5;

        accidentLayer.setRadius(radius);
        accidentLayer.setBlur(blur);
      });
    });

    // === 建立路徑規劃標記圖層（用於顯示起點和終點）===
    const markersSource = new VectorSource();
    const markersLayer = new VectorLayer({
      source: markersSource,
      zIndex: 10000,
      style: (feature) => {
        const type = feature.get("type");
        return new Style({
          image: new CircleStyle({
            radius: 10,
            fill: new Fill({ color: type === "start" ? "#00ff00" : "#ff0000" }),
            stroke: new Stroke({ color: "#ffffff", width: 3 }),
          }),
        });
      },
    });
    mapObj.addLayer(markersLayer);
    markersLayerRef.current = markersLayer;

    // === 監聽 Flutter 位置更新 ===
    const townpassClient = getTownPassClient();
    const unsubscribeLocation = townpassClient.onLocationUpdate((location) => {
      const coords = fromLonLat([location.longitude, location.latitude]);

      if (positionFeatureRef.current) {
        positionFeatureRef.current.setGeometry(new Point(coords));
      }

      // if (mapInstanceRef.current) {
      //   mapInstanceRef.current.getView().animate({
      //     center: coords,
      //     duration: 800,
      //   });
      // }
    });

    return () => {
      unsubscribeLocation();
      mapObj.setTarget(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 載入線段圖層
   * API URL: https://tmp114514.ricecall.com/lines
   * API Response:
   * {
   *   "lines": [
   *     {
   *       "id": 1,
   *       "name": "line1",
   *       "start_lng": 121.5340424,
   *       "start_lat": 25.0226465,
   *       "end_lng": 121.5335406,
   *       "end_lat": 25.0226608,
   *       "bike": 1,
   *       "rd_from": "rd1",
   *       "sidewalk": "sidewalk1"
   *     }
   *   ]
   * }
   * @returns {VectorLayer} 線段圖層
   */
  const loadLinesLayer = async () => {
    try {
      const data = await fetch("https://tmp114514.ricecall.com/lines").then(
        (res) => res.json(),
      );

      // 建立 Features
      const bikeFeatures = data.lines
        .filter((line) => line.bike === 1)
        .map((line) => {
          const startCoord = fromLonLat([line.start_lng, line.start_lat]);
          const endCoord = fromLonLat([line.end_lng, line.end_lat]);

          const lineGeometry = new LineString([startCoord, endCoord]);

          const feature = new Feature({
            geometry: lineGeometry,
            id: line.id,
            name: line.name,
            bike: line.bike,
            rd_from: line.rd_from,
            sidewalk: line.sidewalk,
          });

          return feature;
        });

      // 建立 Vector Source
      const bikeVectorSource = new VectorSource({
        features: bikeFeatures,
      });

      // 建立 Vector Layer 並設定動態樣式
      const bikeVectorLayer = new VectorLayer({
        source: bikeVectorSource,
        visible: false,
        style: () => {
          const zoom = mapInstanceRef.current?.getView()?.getZoom() ?? 18;
          const width = Math.max(1, (zoom - 10) * 0.8);
          return new Style({
            stroke: new Stroke({
              color: "#fd853a",
              width,
            }),
          });
        },
      });

      // 建立 Features
      const sidewalkFeatures = data.lines
        .filter((line) => line.sidewalk !== null && line.sidewalk !== undefined)
        .map((line) => {
          const startCoord = fromLonLat([line.start_lng, line.start_lat]);
          const endCoord = fromLonLat([line.end_lng, line.end_lat]);

          const lineGeometry = new LineString([startCoord, endCoord]);

          const feature = new Feature({
            geometry: lineGeometry,
            id: line.id,
            name: line.name,
            bike: line.bike,
            rd_from: line.rd_from,
            sidewalk: line.sidewalk,
          });

          return feature;
        });

      // 建立 Vector Source
      const sidewalkVectorSource = new VectorSource({
        features: sidewalkFeatures,
      });

      // 建立 Vector Layer 並設定動態樣式
      const sidewalkVectorLayer = new VectorLayer({
        source: sidewalkVectorSource,
        visible: false,
        style: () => {
          const zoom = mapInstanceRef.current?.getView()?.getZoom() ?? 18;
          const width = Math.max(1, (zoom - 10) * 0.8);
          return new Style({
            stroke: new Stroke({
              color: "#76a732",
              width,
            }),
          });
        },
      });

      return [bikeVectorLayer, sidewalkVectorLayer];
    } catch (error) {
      console.error("載入 API 線段圖層失敗:", error);
    }
  };

  /**
   * 載入事故圖層
   * API URL: /accident_a1.json, /accident_a2.json
   * API Response:
   * {
   *   "data": [
   *     { "lon": 121.5340424, "lat": 25.0226465 },
   *     { "lon": 121.5335406, "lat": 25.0226608 },
   *   ]
   * }
   * @returns {VectorLayer} 事故圖層
   */
  const loadAccidentLayer = async () => {
    try {
      const [a1Data, a2Data] = await Promise.all([
        fetch("/accident_a1.json").then((res) => res.json()),
        fetch("/accident_a2.json").then((res) => res.json()),
      ]);

      // 建立 Features
      const features = [];
      a1Data.forEach((p) => {
        features.push(
          new Feature({
            geometry: new Point(fromLonLat([p.lon + 100, p.lat + 20])),
            weight: weightConfig.a1AccidentWeight,
          }),
        );
      });
      a2Data.forEach((p) => {
        features.push(
          new Feature({
            geometry: new Point(fromLonLat([p.lon + 100, p.lat + 20])),
            weight: weightConfig.a2AccidentWeight,
          }),
        );
      });

      // 建立熱力圖圖層
      const heatLayer = new Heatmap({
        source: new VectorSource({ features }),
        blur: 20,
        radius: 10,
        opacity: 0.8,
        visible: false,
      });

      // 設定熱力圖漸層色
      heatLayer.setGradient([
        "#ffe0da",
        "#fcbcb2",
        "#f89a90",
        "#f2786f",
        "#eb5b56",
        "#e23b36",
      ]);

      return heatLayer;
    } catch (error) {
      console.error("載入事故圖層失敗:", error);
    }
  };

  /**
   * 載入當前位置圖層
   * @returns {VectorLayer} 當前位置圖層
   */
  const loadPositionLayer = async () => {
    try {
      // 建立 Feature
      const positionFeature = new Feature();
      positionFeature.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 8,
            fill: new Fill({ color: "#5ab4c5" }),
            stroke: new Stroke({ color: "#fff", width: 2 }),
          }),
        }),
      );

      // 方向扇形 Feature
      const directionFeature = new Feature(new Polygon([[]]));
      directionFeature.setStyle(
        new Style({
          fill: new Fill({ color: "#93d4df" }),
        }),
      );

      // 儲存 Feature 引用供 Flutter 方向更新使用
      positionFeatureRef.current = positionFeature;
      directionFeatureRef.current = directionFeature;

      // 建立 Vector Source
      const vectorSource = new VectorSource({
        features: [positionFeature, directionFeature],
      });

      // 建立 Vector Layer
      const positionLayer = new VectorLayer({ source: vectorSource });

      return positionLayer;
    } catch (error) {
      console.error("載入當前位置圖層失敗:", error);
    }
  };

  /**
   * 切換圖層顯示/隱藏
   */
  const toggleLayer = (layerName) => {
    const layer = layers[layerName];
    if (layer) {
      const newVisible = !layer.getVisible();
      layer.setVisible(newVisible);
      setLayerVisibility((prev) => ({ ...prev, [layerName]: newVisible }));
    }
  };

  // 取得定位資訊
  useEffect(() => {
    if (!map) return;

    if ("geolocation" in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const coords = fromLonLat([
            pos.coords.longitude,
            pos.coords.latitude,
          ]);

          setPosition(coords);

          if (positionFeatureRef.current) {
            positionFeatureRef.current.setGeometry(new Point(coords));
          }

          if (
            !isInitializedRef &&
            view &&
            (!searchParams.get("lon") || !searchParams.get("lat"))
          ) {
            view.setCenter(coords);
            isInitializedRef.current = true;
          }
        },
        (err) => console.error(`取得定位資訊失敗: ${err}`),
        { enableHighAccuracy: true },
      );

      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, [map]);

  // 取得方向資訊
  useEffect(() => {
    const handleOrientation = (event) => {
      const alpha = event.alpha ?? 0;
      const angle = (alpha + 180) % 360;
      setOrientation(angle);
    };

    if (window.DeviceOrientationEvent) {
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        // iOS
        DeviceOrientationEvent.requestPermission()
          .then((res) => {
            if (res === "granted") {
              window.addEventListener(
                "deviceorientationabsolute",
                handleOrientation,
              );
            }
          })
          .catch(console.error);
      } else {
        window.addEventListener("deviceorientationabsolute", handleOrientation);
      }
    }

    return () => {
      window.removeEventListener(
        "deviceorientationabsolute",
        handleOrientation,
      );
    };
  }, []);

  // 更新扇形方向
  useEffect(() => {
    if (!position || orientation === null) return;

    const [x, y] = position;
    const radius = 40; // 扇形半徑
    const spread = 90; // 夾角（度）
    const steps = 20; // 圓弧細分數量
    const rad = (orientation * Math.PI) / 180;
    const half = (spread * Math.PI) / 360;

    const coords = [[x, y]];

    // 生成圓弧座標（順時針方向）
    for (let i = -half; i <= half; i += (spread * Math.PI) / (180 * steps)) {
      const px = x + Math.sin(rad + i) * radius;
      const py = y - Math.cos(rad + i) * radius;
      coords.push([px, py]);
    }

    coords.push([x, y]); // 封閉
    directionFeatureRef.current?.getGeometry()?.setCoordinates([coords]);
  }, [position, orientation]);

  // 同步圖層可見性狀態
  useEffect(() => {
    const visibility = {};
    Object.keys(layers).forEach((name) => {
      visibility[name] = layers[name]?.getVisible() ?? false;
    });
    setLayerVisibility(visibility);
  }, [layers]);

  return (
    <div className="relative flex h-screen w-full flex-col">
      {/* 模式選擇器 - 置於地圖上方 */}
      <div className="">
        <MapModeSelector
          currentMode={currentMode}
          setCurrentMode={setCurrentMode}
        />
      </div>

      <div className="relative flex-1">
        {/* 地圖 */}
        <div ref={mapRef} className="h-full w-full" />

        {/* 圖層切換器 */}
        <LayerSwitcher
          layers={layers}
          layerVisibility={layerVisibility}
          toggleLayer={toggleLayer}
        />

        {/* 路徑規劃按鈕 */}
        {currentMode != "vehicle" && center && view && (
          <div className="absolute bottom-15 left-1/2 z-[1000] w-fit -translate-x-1/2 rounded-md bg-[#5ab4c5] p-2.5 px-10 font-bold text-white shadow-lg">
            <a
              href={`/${currentMode === "pedestrian" ? "walk" : currentMode === "bicycle" ? "bike" : ""}?lon=${center[0]}&lat=${center[1]}&zoom=${view?.getZoom()}`}
            >
              路徑規劃
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

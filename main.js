import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SMS from "expo-sms";

import { onAuthStateChanged, signInAnonymously } from "firebase/auth";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { auth, db } from "./firebase";

const NEARBY_ALERT_RADIUS = 2000;
const DANGER_ZONE_RADIUS = 500;
const DANGER_REPORT_MINIMUM_COUNT = 2;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const [user, setUser] = useState(null);

  const [name, setName] = useState("");
  const [trustedPhone, setTrustedPhone] = useState("");

  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [myLocation, setMyLocation] = useState(null);

  const [activeAlertId, setActiveAlertId] = useState(null);

  const [nearbyAlerts, setNearbyAlerts] = useState([]);
  const [dangerReports, setDangerReports] = useState([]);
  const [dangerWarning, setDangerWarning] = useState("");

  const [dangerNote, setDangerNote] = useState("");

  const regularLocationWatcher = useRef(null);
  const sosLocationWatcher = useRef(null);
  const notifiedAlertIds = useRef(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      try {
        if (currentUser) {
          setUser(currentUser);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        Alert.alert("Authentication Error", error.message);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    requestPermissionsAndInitialLocation();

    return () => {
      if (regularLocationWatcher.current) {
        regularLocationWatcher.current.remove();
      }

      if (sosLocationWatcher.current) {
        sosLocationWatcher.current.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    loadUserProfile();
  }, [user]);

  useEffect(() => {
    if (!user || !hasLocationPermission) return;

    startRegularLocationUpdates();

    return () => {
      if (regularLocationWatcher.current) {
        regularLocationWatcher.current.remove();
        regularLocationWatcher.current = null;
      }
    };
  }, [user, hasLocationPermission]);

  useEffect(() => {
    if (!user || !myLocation) return;

    const alertsQuery = query(
      collection(db, "alerts"),
      where("active", "==", true)
    );

    const unsubscribe = onSnapshot(
      alertsQuery,
      (snapshot) => {
        const alerts = [];

        snapshot.forEach((document) => {
          const data = document.data();

          if (!data.location) return;
          if (data.userId === user.uid) return;

          const distance = getDistanceInMeters(
            myLocation.latitude,
            myLocation.longitude,
            data.location.latitude,
            data.location.longitude
          );

          if (distance <= NEARBY_ALERT_RADIUS) {
            const alertItem = {
              id: document.id,
              ...data,
              distance,
            };

            alerts.push(alertItem);

            if (!notifiedAlertIds.current.has(document.id)) {
              notifiedAlertIds.current.add(document.id);

              Notifications.scheduleNotificationAsync({
                content: {
                  title: "Emergency Nearby",
                  body: `Someone needs help ${formatDistance(distance)} away.`,
                },
                trigger: null,
              });
            }
          }
        });

        alerts.sort((a, b) => a.distance - b.distance);
        setNearbyAlerts(alerts);
      },
      (error) => {
        console.log("Nearby alert error:", error.message);
      }
    );

    return unsubscribe;
  }, [user, myLocation]);

  useEffect(() => {
    if (!myLocation) return;

    const reportsQuery = query(
      collection(db, "dangerReports"),
      orderBy("createdAt", "desc"),
      limit(100)
    );

    const unsubscribe = onSnapshot(
      reportsQuery,
      (snapshot) => {
        const reports = [];

        snapshot.forEach((document) => {
          const data = document.data();

          if (!data.location) return;

          const distance = getDistanceInMeters(
            myLocation.latitude,
            myLocation.longitude,
            data.location.latitude,
            data.location.longitude
          );

          if (distance <= DANGER_ZONE_RADIUS) {
            reports.push({
              id: document.id,
              ...data,
              distance,
            });
          }
        });

        reports.sort((a, b) => a.distance - b.distance);
        setDangerReports(reports);

        if (reports.length >= DANGER_REPORT_MINIMUM_COUNT) {
          setDangerWarning("Warning: You are near a reported danger zone.");
        } else {
          setDangerWarning("");
        }
      },
      (error) => {
        console.log("Danger report error:", error.message);
      }
    );

    return unsubscribe;
  }, [myLocation]);

  async function requestPermissionsAndInitialLocation() {
    try {
      const locationPermission =
        await Location.requestForegroundPermissionsAsync();

      if (locationPermission.status !== "granted") {
        Alert.alert(
          "Permission Required",
          "Location permission is required for this safety app."
        );
        return;
      }

      setHasLocationPermission(true);

      const notificationPermission =
        await Notifications.requestPermissionsAsync();

      if (notificationPermission.status !== "granted") {
        Alert.alert(
          "Notification Permission",
          "Notifications are recommended for nearby emergency alerts."
        );
      }

      const location = await getFreshLocation();
      setMyLocation(location);
    } catch (error) {
      Alert.alert("Permission Error", error.message);
    }
  }

  async function getFreshLocation() {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy || null,
    };
  }

  async function loadUserProfile() {
    try {
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const data = userSnap.data();

        setName(data.name || "");
        setTrustedPhone(data.trustedPhone || "");

        await setDoc(
          userRef,
          {
            uid: user.uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        await setDoc(userRef, {
          uid: user.uid,
          name: "",
          trustedPhone: "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      Alert.alert("Profile Error", error.message);
    }
  }

  async function saveProfile() {
    if (!user) return;

    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          uid: user.uid,
          name: name.trim(),
          trustedPhone: trustedPhone.trim(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      Alert.alert("Saved", "Profile saved successfully.");
    } catch (error) {
      Alert.alert("Save Error", error.message);
    }
  }

  async function startRegularLocationUpdates() {
    try {
      if (regularLocationWatcher.current) {
        regularLocationWatcher.current.remove();
      }

      regularLocationWatcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 8000,
          distanceInterval: 10,
        },
        async (position) => {
          const location = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy || null,
          };

          setMyLocation(location);
          await updateUserLocation(location);
        }
      );
    } catch (error) {
      console.log("Regular location error:", error.message);
    }
  }

  async function updateUserLocation(location) {
    if (!user) return;

    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          lastLocation: location,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      console.log("Update location error:", error.message);
    }
  }

  async function startSOS() {
    if (!user) {
      Alert.alert("Error", "User not ready.");
      return;
    }

    try {
      let location = myLocation;

      if (!location) {
        location = await getFreshLocation();
        setMyLocation(location);
      }

      const alertRef = await addDoc(collection(db, "alerts"), {
        userId: user.uid,
        reporterName: name.trim() || "Anonymous",
        trustedPhone: trustedPhone.trim(),
        message: "SOS! I need immediate help.",
        active: true,
        location,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setActiveAlertId(alertRef.id);

      if (sosLocationWatcher.current) {
        sosLocationWatcher.current.remove();
      }

      sosLocationWatcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 5,
        },
        async (position) => {
          const newLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy || null,
          };

          setMyLocation(newLocation);

          await updateDoc(doc(db, "alerts", alertRef.id), {
            location: newLocation,
            updatedAt: serverTimestamp(),
          });

          await updateUserLocation(newLocation);
        }
      );

      Alert.alert(
        "SOS Activated",
        "Your emergency alert and live location are now active.",
        [
          {
            text: "OK",
          },
          {
            text: "Send SMS",
            onPress: () => sendEmergencySMS(location),
          },
        ]
      );
    } catch (error) {
      Alert.alert("SOS Error", error.message);
    }
  }

  async function stopSOS() {
    if (!activeAlertId) return;

    try {
      if (sosLocationWatcher.current) {
        sosLocationWatcher.current.remove();
        sosLocationWatcher.current = null;
      }

      await updateDoc(doc(db, "alerts", activeAlertId), {
        active: false,
        endedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setActiveAlertId(null);

      Alert.alert("SOS Stopped", "Emergency alert has been stopped.");
    } catch (error) {
      Alert.alert("Stop SOS Error", error.message);
    }
  }

  async function reportDangerZone() {
    if (!user) {
      Alert.alert("Error", "User not ready.");
      return;
    }

    try {
      let location = myLocation;

      if (!location) {
        location = await getFreshLocation();
        setMyLocation(location);
      }

      await addDoc(collection(db, "dangerReports"), {
        userId: user.uid,
        reporterName: name.trim() || "Anonymous",
        type: "unsafe_area",
        note: dangerNote.trim() || "User reported this area as unsafe.",
        location,
        createdAt: serverTimestamp(),
      });

      setDangerNote("");

      Alert.alert("Reported", "Danger zone report submitted.");
    } catch (error) {
      Alert.alert("Report Error", error.message);
    }
  }

  async function sendEmergencySMS(locationOverride = null) {
    try {
      if (!trustedPhone.trim()) {
        Alert.alert("Missing Contact", "Please add trusted contact number.");
        return;
      }

      const isAvailable = await SMS.isAvailableAsync();

      if (!isAvailable) {
        Alert.alert("SMS Not Available", "SMS is not available on this device.");
        return;
      }

      const location = locationOverride || myLocation;

      let mapsLink = "Location not available";

      if (location) {
        mapsLink = `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
      }

      const message = `EMERGENCY SOS! I need help. My live location: ${mapsLink}`;

      await SMS.sendSMSAsync([trustedPhone.trim()], message);
    } catch (error) {
      Alert.alert("SMS Error", error.message);
    }
  }

  function callTrustedContact() {
    if (!trustedPhone.trim()) {
      Alert.alert("Missing Contact", "Please add trusted contact number.");
      return;
    }

    Linking.openURL(`tel:${trustedPhone.trim()}`);
  }

  function openInMaps(location) {
    if (!location) return;

    const url = `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
    Linking.openURL(url);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Smart Women Safety App</Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Profile</Text>

        <TextInput
          style={styles.input}
          placeholder="Your Name"
          value={name}
          onChangeText={setName}
        />

        <TextInput
          style={styles.input}
          placeholder="Trusted Contact Phone Number"
          value={trustedPhone}
          onChangeText={setTrustedPhone}
          keyboardType="phone-pad"
        />

        <Button title="Save Profile" onPress={saveProfile} />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Current Location</Text>

        {myLocation ? (
          <>
            <Text>Latitude: {myLocation.latitude}</Text>
            <Text>Longitude: {myLocation.longitude}</Text>
            <Text>
              Accuracy:{" "}
              {myLocation.accuracy ? `${Math.round(myLocation.accuracy)} m` : "N/A"}
            </Text>

            <View style={styles.smallButton}>
              <Button title="Open My Location" onPress={() => openInMaps(myLocation)} />
            </View>
          </>
        ) : (
          <Text>Fetching location...</Text>
        )}
      </View>

      {dangerWarning !== "" && (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>{dangerWarning}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.sosButton,
          activeAlertId ? styles.stopButton : styles.startButton,
        ]}
        onPress={activeAlertId ? stopSOS : startSOS}
      >
        <Text style={styles.sosText}>
          {activeAlertId ? "STOP SOS" : "SOS EMERGENCY"}
        </Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.heading}>Emergency Contact</Text>

        <View style={styles.rowButtons}>
          <View style={styles.halfButton}>
            <Button title="Call" onPress={callTrustedContact} />
          </View>

          <View style={styles.halfButton}>
            <Button title="Send SMS" onPress={() => sendEmergencySMS()} />
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Report Danger Zone</Text>

        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder="Write a note, e.g. dark street, harassment, unsafe area"
          value={dangerNote}
          onChangeText={setDangerNote}
          multiline
        />

        <Button title="Submit Danger Report" onPress={reportDangerZone} />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Nearby Emergency Alerts</Text>

        {nearbyAlerts.length === 0 ? (
          <Text>No nearby emergency alerts.</Text>
        ) : (
          nearbyAlerts.map((alert) => (
            <View key={alert.id} style={styles.alertItem}>
              <Text style={styles.alertTitle}>{alert.message}</Text>
              <Text>Name: {alert.reporterName || "Anonymous"}</Text>
              <Text>Distance: {formatDistance(alert.distance)}</Text>

              <View style={styles.smallButton}>
                <Button
                  title="Open Alert Location"
                  onPress={() => openInMaps(alert.location)}
                />
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Nearby Danger Reports</Text>

        {dangerReports.length === 0 ? (
          <Text>No danger reports nearby.</Text>
        ) : (
          dangerReports.map((report) => (
            <View key={report.id} style={styles.dangerItem}>
              <Text style={styles.dangerTitle}>{report.note}</Text>
              <Text>Reported by: {report.reporterName || "Anonymous"}</Text>
              <Text>Distance: {formatDistance(report.distance)}</Text>

              <View style={styles.smallButton}>
                <Button
                  title="Open Report Location"
                  onPress={() => openInMaps(report.location)}
                />
              </View>
            </View>
          ))
        )}
      </View>

      <Text style={styles.footer}>
        This is a project/demo app. For real emergencies, contact local emergency
        services immediately.
      </Text>
    </ScrollView>
  );
}

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function toRadians(value) {
  return value * (Math.PI / 180);
}

function formatDistance(distance) {
  if (!distance && distance !== 0) return "N/A";

  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(2)} km`;
  }

  return `${Math.round(distance)} m`;
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingTop: 60,
    backgroundColor: "#f4f6f8",
  },

  title: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#222",
    textAlign: "center",
    marginBottom: 25,
  },

  card: {
    backgroundColor: "#ffffff",
    padding: 15,
    borderRadius: 12,
    marginBottom: 15,
    elevation: 3,
  },

  heading: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 12,
    color: "#222",
  },

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    backgroundColor: "#fff",
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },

  textArea: {
    minHeight: 80,
    textAlignVertical: "top",
  },

  sosButton: {
    paddingVertical: 30,
    borderRadius: 100,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 20,
  },

  startButton: {
    backgroundColor: "#e63946",
  },

  stopButton: {
    backgroundColor: "#222",
  },

  sosText: {
    color: "#fff",
    fontSize: 25,
    fontWeight: "bold",
  },

  warningBox: {
    backgroundColor: "#ffcc00",
    padding: 15,
    borderRadius: 10,
    marginBottom: 15,
  },

  warningText: {
    color: "#222",
    fontWeight: "bold",
    fontSize: 16,
  },

  rowButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
  },

  halfButton: {
    width: "48%",
  },

  smallButton: {
    marginTop: 10,
  },

  alertItem: {
    backgroundColor: "#ffe6e6",
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
  },

  alertTitle: {
    color: "#e63946",
    fontWeight: "bold",
    marginBottom: 5,
  },

  dangerItem: {
    backgroundColor: "#fff3cd",
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
  },

  dangerTitle: {
    color: "#8a5a00",
    fontWeight: "bold",
    marginBottom: 5,
  },

  footer: {
    textAlign: "center",
    color: "#777",
    fontSize: 12,
    marginTop: 10,
    marginBottom: 30,
  },
});

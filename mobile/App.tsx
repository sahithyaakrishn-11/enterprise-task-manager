import { useState } from "react";
import {
  SafeAreaView,
  Text,
  Button,
  View,
  TextInput,
  FlatList,
  Alert,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import {
  NavigationContainer,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
} from "@react-navigation/native-stack";

WebBrowser.maybeCompleteAuthSession();

type Task = {
  id: number;
  title: string;
};

type RootStackParamList = {
  Login: undefined;
  Dashboard: {
    accessToken: string;
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function LoginScreen({ navigation }: any) {
  const [message, setMessage] = useState("Not logged in");

  const login = async () => {
    const redirectUri = "enterprise-task-manager://redirect";

    const authUrl =
      "http://10.0.2.2:8080/realms/enterprise-task-manager/protocol/openid-connect/auth" +
      "?client_id=enterprise-task-manager" +
      "&redirect_uri=" +
      encodeURIComponent(redirectUri) +
      "&response_type=code" +
      "&scope=openid";

    setMessage("Opening Keycloak...");

    const result = await WebBrowser.openAuthSessionAsync(
      authUrl,
      redirectUri
    );

    if (result.type !== "success") {
      setMessage("Login cancelled or failed");
      return;
    }

    const code = new URL(result.url).searchParams.get("code");

    if (!code) {
      setMessage("No authorization code received");
      return;
    }

    setMessage("Getting access token...");

    try {
      const tokenResponse = await fetch(
        "http://10.0.2.2:8080/realms/enterprise-task-manager/protocol/openid-connect/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body:
            "grant_type=authorization_code" +
            "&client_id=enterprise-task-manager" +
            "&code=" +
            encodeURIComponent(code) +
            "&redirect_uri=" +
            encodeURIComponent(redirectUri),
        }
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        console.log("TOKEN ERROR:", tokenData);
        setMessage("Failed to get access token");
        return;
      }

      setMessage("Login successful! ✅");

      navigation.replace("Dashboard", {
        accessToken: tokenData.access_token,
      });
    } catch (error) {
      console.log("TOKEN REQUEST ERROR:", error);
      setMessage("Token request failed");
    }
  };

  return (
    <SafeAreaView
      style={{
        flex: 1,
        justifyContent: "center",
        padding: 20,
      }}
    >
      <Text
        style={{
          fontSize: 30,
          fontWeight: "bold",
          textAlign: "center",
          marginBottom: 20,
        }}
      >
        Enterprise Task Manager
      </Text>

      <Text
        style={{
          fontSize: 16,
          textAlign: "center",
          marginBottom: 25,
        }}
      >
        {message}
      </Text>

      <Button
        title="Login with Keycloak"
        onPress={login}
      />
    </SafeAreaView>
  );
}

function DashboardScreen({ route }: any) {
  const accessToken = route.params.accessToken;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [message, setMessage] = useState("Loading tasks...");

  const getTasks = async () => {
    try {
      const response = await fetch(
        "http://10.0.2.2:3000/tasks",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setMessage(`API error: ${response.status}`);
        return;
      }

      setTasks(data);
      setMessage(`Tasks loaded: ${data.length} ✅`);
    } catch (error) {
      console.log("GET TASKS ERROR:", error);
      setMessage("Could not connect to Rust API");
    }
  };

  const createTask = async () => {
    if (!title.trim()) {
      Alert.alert("Error", "Enter a task title");
      return;
    }

    try {
      const response = await fetch(
        "http://10.0.2.2:3000/tasks",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            title: title.trim(),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setMessage(`Create failed: ${response.status}`);
        return;
      }

      setTitle("");
      setMessage(`Task ${data.id} created ✅`);

      await getTasks();
    } catch (error) {
      console.log("CREATE TASK ERROR:", error);
      setMessage("Could not connect to Rust API");
    }
  };

  const startEdit = (task: Task) => {
    setEditingId(task.id);
    setTitle(task.title);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setTitle("");
  };

  const updateTask = async () => {
    if (editingId === null) {
      return;
    }

    if (!title.trim()) {
      Alert.alert("Error", "Enter a task title");
      return;
    }

    try {
      const response = await fetch(
        `http://10.0.2.2:3000/tasks/${editingId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            title: title.trim(),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setMessage(`Update failed: ${response.status}`);
        return;
      }

      setEditingId(null);
      setTitle("");
      setMessage(`Task ${data.id} updated ✅`);

      await getTasks();
    } catch (error) {
      console.log("UPDATE TASK ERROR:", error);
      setMessage("Could not connect to Rust API");
    }
  };

  const deleteTask = (id: number) => {
    Alert.alert(
      "Delete Task",
      "Are you sure you want to delete this task?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const response = await fetch(
                `http://10.0.2.2:3000/tasks/${id}`,
                {
                  method: "DELETE",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                  },
                }
              );

              if (!response.ok) {
                setMessage(`Delete failed: ${response.status}`);
                return;
              }

              setMessage(`Task ${id} deleted ✅`);

              await getTasks();
            } catch (error) {
              console.log("DELETE TASK ERROR:", error);
              setMessage("Could not connect to Rust API");
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView
      style={{
        flex: 1,
        padding: 20,
      }}
    >
      <Text
        style={{
          fontSize: 28,
          fontWeight: "bold",
          marginBottom: 10,
        }}
      >
        Task Dashboard
      </Text>

      <Text
        style={{
          marginBottom: 20,
        }}
      >
        {message}
      </Text>

      <Button
        title="Refresh Tasks"
        onPress={getTasks}
      />

      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder={
          editingId !== null
            ? "Edit task title"
            : "Enter task title"
        }
        style={{
          borderWidth: 1,
          borderColor: "#999",
          borderRadius: 6,
          padding: 12,
          marginTop: 20,
          marginBottom: 10,
        }}
      />

      {editingId !== null ? (
        <View>
          <Button
            title="Update Task"
            onPress={updateTask}
          />

          <View style={{ marginTop: 8 }}>
            <Button
              title="Cancel Edit"
              onPress={cancelEdit}
            />
          </View>
        </View>
      ) : (
        <Button
          title="Create Task"
          onPress={createTask}
        />
      )}

      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id.toString()}
        style={{ marginTop: 20 }}
        renderItem={({ item }) => (
          <View
            style={{
              padding: 15,
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 6,
              marginBottom: 10,
            }}
          >
            <Text
              style={{
                fontSize: 17,
                fontWeight: "bold",
                marginBottom: 10,
              }}
            >
              {item.id}. {item.title}
            </Text>

            <View style={{ marginBottom: 8 }}>
              <Button
                title="Edit"
                onPress={() => startEdit(item)}
              />
            </View>

            <Button
              title="Delete"
              onPress={() => deleteTask(item.id)}
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen
          name="Login"
          component={LoginScreen}
          options={{
            headerShown: false,
          }}
        />

        <Stack.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{
            title: "Enterprise Task Manager",
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
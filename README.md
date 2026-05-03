[![CircleCI](https://circleci.com/gh/thoughtpivot/scribe/tree/master.svg?style=svg)](https://circleci.com/gh/thoughtpivot/scribe/tree/master)
[![Known Vulnerabilities](https://snyk.io/test/github/thoughtpivot/scribe/badge.svg)](https://snyk.io/test/github/thoughtpivot/scribe)
[![npm (scoped)](https://img.shields.io/npm/v/@thoughtpivot/scribe.svg)](https://www.npmjs.com/package/@thoughtpivot/scribe)
[![NpmLicense](https://img.shields.io/npm/l/@thoughtpivot/scribe.svg)](https://github.com/thoughtpivot/scribe/blob/master/LICENSE)

# Scribe

Scribe is **ThoughtPivot** technology—a data modeling service built around a component-based architecture paradigm, designed to bring structure, reusability, and modularity to backend data systems in the same way that modern frontend frameworks like React or Vue do for UI. While it exposes a RESTful API interface, Scribe is more than just an API server—it’s a flexible framework for modeling domain logic as discrete components and subcomponents, each defined by JSON Schema. These components encapsulate their own validation rules, version history, and relational structure, enabling composable data models that can scale with application complexity. With built-in support for PostgreSQL, Redis caching, dynamic querying, time-based data introspection, and SQL passthroughs, Scribe offers a powerful foundation for building maintainable, schema-driven backends that are easy to reason about and evolve over time.

## Project Structure

Scribe assumes your application follows a component-based directory structure:

```
my-app/
├── components/           # Application components
│   ├── Users/          # User component directory
│   │   ├── Users.schema.json    # Component schema definition
│   │   └── Users.backend.ts     # Backend routes and logic
│   ├── Products/       # Product component directory
│   │   ├── Products.schema.json # Component schema definition
│   │   └── Products.backend.ts  # Backend routes and logic
│   └── Orders/         # Order component directory
│       ├── Orders.schema.json   # Component schema definition
│       └── Orders.backend.ts    # Backend routes and logic
├── assets/             # Static assets
└── dist/              # Production build output
```

## How Data Components Work

In Scribe, a component represents a distinct data model with its own schema, validation rules, and history tracking. Components are defined using JSON Schema definitions, providing a powerful and flexible way to validate and structure your data on a per component basis.

### Component Schema Definition

Each component in Scribe is defined by a JSON Schema definition that specifies:

-   Required fields
-   Data types
-   Validation rules
-   Default values
-   Custom formats

For example, a Users component and its Profile subcomponent might be defined as:

```json
// components/Users/Users.schema.json
{
    "$schema": "http://json-schema.org/draft-07/schema",
    "type": "object",
    "required": ["name", "email", "status"],
    "properties": {
        "name": {
            "type": "string",
            "minLength": 2,
            "maxLength": 100
        },
        "email": {
            "type": "string",
            "format": "email"
        },
        "status": {
            "type": "string",
            "enum": ["active", "inactive", "suspended"]
        },
        "role": {
            "type": "string",
            "enum": ["admin", "user", "guest"]
        },
        "last_login": {
            "type": "string",
            "format": "date-time"
        }
    }
}

// components/Users/Profile/Profile.schema.json
{
    "$schema": "http://json-schema.org/draft-07/schema",
    "type": "object",
    "required": ["user_id", "avatar_url"],
    "properties": {
        "user_id": {
            "type": "integer",
            "description": "Reference to the parent Users component"
        },
        "avatar_url": {
            "type": "string",
            "format": "uri"
        },
        "bio": {
            "type": "string",
            "maxLength": 500
        },
        "location": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string"
                },
                "country": {
                    "type": "string"
                },
                "timezone": {
                    "type": "string"
                }
            }
        },
        "preferences": {
            "type": "object",
            "properties": {
                "theme": {
                    "type": "string",
                    "enum": ["light", "dark", "system"]
                },
                "notifications": {
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "boolean"
                        },
                        "push": {
                            "type": "boolean"
                        }
                    }
                }
            }
        }
    }
}
```

When creating records, the data is automatically wrapped in the default schema structure:

```typescript
// Creating a user
POST /users
{
    "data": {
        "name": "John Doe",
        "email": "john@example.com",
        "status": "active",
        "role": "user"
    }
}

// Creating a user profile
POST /users/profile
{
    "data": {
        "user_id": 1,
        "avatar_url": "https://example.com/avatars/john.jpg",
        "bio": "Software engineer and coffee enthusiast",
        "location": {
            "city": "San Francisco",
            "country": "USA",
            "timezone": "America/Los_Angeles"
        },
        "preferences": {
            "theme": "dark",
            "notifications": {
                "email": true,
                "push": false
            }
        }
    }
}
```

Components can be:

-   **Base Components**: Like `Users` or `Products`
-   **Subcomponents**: Extensions of base components like `Users/Profile` or `Products/Inventory`
-   **Related**: Through parent-child relationships or references

For example, an e-commerce system might be modeled as:

```json
// components/Products/Products.schema.json
{
    "$schema": "http://json-schema.org/draft-07/schema",
    "type": "object",
    "required": ["name", "price", "category"],
    "properties": {
        "name": {
            "type": "string",
            "minLength": 3,
            "maxLength": 100
        },
        "price": {
            "type": "number",
            "minimum": 0
        },
        "category": {
            "type": "string",
            "enum": ["electronics", "clothing", "books"]
        },
        "description": {
            "type": "string",
            "maxLength": 1000
        },
        "tags": {
            "type": "array",
            "items": {
                "type": "string"
            }
        }
    }
}

// components/Products/Inventory/Inventory.schema.json
{
    "$schema": "http://json-schema.org/draft-07/schema",
    "type": "object",
    "required": ["product_id", "sku", "stock_level"],
    "properties": {
        "product_id": {
            "type": "integer",
            "description": "Reference to the parent Product component"
        },
        "sku": {
            "type": "string",
            "pattern": "^[A-Z0-9-]+$"
        },
        "stock_level": {
            "type": "integer",
            "minimum": 0
        },
        "warehouse": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string"
                },
                "section": {
                    "type": "string"
                },
                "bin": {
                    "type": "string"
                }
            }
        },
        "reorder_point": {
            "type": "integer",
            "minimum": 0
        }
    }
}
```

Each component and subcomponent automatically gets:

-   Schema validation
-   Version history tracking
-   Relationship querying
-   Time machine capabilities

This component-based approach makes it natural to:

-   Organize complex data models
-   Maintain data integrity
-   Track changes over time
-   Scale your data architecture

### Default Schema Fields

Every component in Scribe automatically includes these base fields:

-   `data`: The main component data object
-   `date_created`: Timestamp of creation
-   `date_modified`: Timestamp of last modification
-   `created_by`: ID of the user who created the record
-   `modified_by`: ID of the user who last modified the record

## Features

-   **Schema Validation**: Automatic validation of data against JSON schemas
-   **History Tracking**: Built-in version history for all records
-   **Redis Caching**: Schema caching for improved performance
-   **PostgreSQL Storage**: Reliable and scalable data storage
-   **Complex Queries**: Support for filtering, grouping, and relationships
-   **Time Machine**: Ability to view data as it existed at any point in time
-   **Multi-language Support**: Easy to use from any programming language
-   **Flexible SQL Queries**: Support for complex SQL operations including joins, aggregations, and subqueries
-   **Query Parameter Support**: Easy filtering, sorting, and pagination through URL parameters
-   **Transaction Support**: Atomic operations for data integrity
-   **Dynamic Query Building**: API for constructing complex queries programmatically
-   **Raw SQL Access**: Direct SQL execution for advanced use cases

## Installation

### Prerequisites

-   Node.js >= 12
-   PostgreSQL >= 9.6.10
-   Redis (optional, for schema caching)

```bash
npm install @thoughtpivot/scribe
```

## Configuration

Scribe can be configured through environment variables or command line arguments:

```bash
# Required
SCRIBE_APP_DB_HOST=localhost
SCRIBE_APP_DB_USER=your_user
SCRIBE_APP_DB_PASS=your_password
SCRIBE_APP_DB_NAME=your_database

# Optional
SCRIBE_APP_PORT=1337
SCRIBE_APP_MODE=development
SCRIBE_APP_SCHEMA_BASE_URL=http://your-schema-server
```

## Usage Examples

### TypeScript with Axios

```typescript
import axios from "axios"

const scribeClient = axios.create({
    baseURL: "http://localhost:1337"
})

// Create a new record
const createUser = async () => {
    const response = await scribeClient.post("/users", {
        name: "John Doe",
        email: "john@example.com",
        age: 30
    })
    return response.data
}

// Get a record by ID
const getUser = async (id: string) => {
    const response = await scribeClient.get(`/users/${id}`)
    return response.data
}

// Get all records with filtering
const getUsers = async () => {
    const response = await scribeClient.get("/users/all", {
        params: {
            filter: JSON.stringify({
                age: [25, 30, 35]
            })
        }
    })
    return response.data
}

// Update a record
const updateUser = async (id: string, data: any) => {
    const response = await scribeClient.put(`/users/${id}`, data)
    return response.data
}

// Get history of a record
const getUserHistory = async (id: string) => {
    const response = await scribeClient.get(`/users/${id}/history`)
    return response.data
}
```

### Go with net/http

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

type User struct {
    Name  string `json:"name"`
    Email string `json:"email"`
    Age   int    `json:"age"`
}

func createUser(user User) (*User, error) {
    data, err := json.Marshal(user)
    if err != nil {
        return nil, err
    }

    resp, err := http.Post("http://localhost:1337/users", "application/json", bytes.NewBuffer(data))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result User
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    return &result, nil
}

func getUser(id string) (*User, error) {
    resp, err := http.Get(fmt.Sprintf("http://localhost:1337/users/%s", id))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result []User
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    if len(result) == 0 {
        return nil, fmt.Errorf("user not found")
    }

    return &result[0], nil
}

func getUsers() ([]User, error) {
    filter := map[string][]int{"age": {25, 30, 35}}
    filterJSON, err := json.Marshal(filter)
    if err != nil {
        return nil, err
    }

    resp, err := http.Get(fmt.Sprintf("http://localhost:1337/users/all?filter=%s", string(filterJSON)))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result []User
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    return result, nil
}
```

### Python with requests

```python
import requests
import json

class ScribeClient:
    def __init__(self, base_url="http://localhost:1337"):
        self.base_url = base_url

    def create_user(self, user_data):
        response = requests.post(
            f"{self.base_url}/users",
            json=user_data
        )
        return response.json()

    def get_user(self, user_id):
        response = requests.get(f"{self.base_url}/users/{user_id}")
        return response.json()

    def get_users(self, filter_data=None):
        params = {}
        if filter_data:
            params['filter'] = json.dumps(filter_data)

        response = requests.get(
            f"{self.base_url}/users/all",
            params=params
        )
        return response.json()

    def update_user(self, user_id, user_data):
        response = requests.put(
            f"{self.base_url}/users/{user_id}",
            json=user_data
        )
        return response.json()

    def get_user_history(self, user_id):
        response = requests.get(f"{self.base_url}/users/{user_id}/history")
        return response.json()

# Usage example
client = ScribeClient()

# Create a user
user = client.create_user({
    "name": "John Doe",
    "email": "john@example.com",
    "age": 30
})

# Get user by ID
user_data = client.get_user(user[0]["id"])

# Get users with filter
users = client.get_users({"age": [25, 30, 35]})

# Update user
updated_user = client.update_user(user[0]["id"], {
    "name": "John Doe",
    "email": "john@example.com",
    "age": 31
})

# Get user history
history = client.get_user_history(user[0]["id"])
```

## Advanced Features

### Time Machine

Scribe supports viewing data as it existed at any point in time:

```typescript
// Get data as it existed at a specific timestamp
const getHistoricalData = async (id: string, timestamp: string) => {
    const response = await scribeClient.get(`/users/${id}`, {
        params: {
            timeMachine: JSON.stringify({
                key: "updatedAt",
                timestamp: timestamp
            })
        }
    })
    return response.data
}
```

### Relationships

Scribe supports querying related data:

```typescript
// Get parent records
const getParentRecords = async (id: string) => {
    const response = await scribeClient.get(`/users/${id}`, {
        params: {
            parents: "parentId"
        }
    })
    return response.data
}

// Get child records
const getChildRecords = async (id: string) => {
    const response = await scribeClient.get(`/users/${id}`, {
        params: {
            children: "parentId"
        }
    })
    return response.data
}
```

### SQL Queries

Scribe provides a direct SQL endpoint for advanced querying capabilities. All queries are executed against PostgreSQL 9.x and above:

```typescript
// Execute a custom SQL query
const executeSqlQuery = async (query: string) => {
    const response = await scribeClient.post("/sql", {
        query: query
    })
    return response.data
}

// Example: Basic JOIN query (compatible with all PostgreSQL versions)
const getUsersWithOrders = async () => {
    const query = `
        SELECT u.*, o.*
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE o.status = 'completed'
        ORDER BY u.created_at DESC
    `
    return executeSqlQuery(query)
}

// Example: Aggregation with GROUP BY (compatible with all PostgreSQL versions)
const getOrderStats = async () => {
    const query = `
        SELECT 
            user_id,
            COUNT(*) as total_orders,
            SUM(amount) as total_amount,
            AVG(amount) as average_order_value
        FROM orders
        WHERE status = 'completed'
        GROUP BY user_id
        HAVING COUNT(*) > 5
        ORDER BY total_amount DESC
    `
    return executeSqlQuery(query)
}

// Example: Window functions (available in PostgreSQL 9.0+)
const getTopCustomers = async () => {
    const query = `
        SELECT 
            u.name,
            u.email,
            COUNT(o.id) as order_count,
            SUM(o.amount) as total_spent,
            ROW_NUMBER() OVER (ORDER BY SUM(o.amount) DESC) as rank
        FROM users u
        JOIN orders o ON u.id = o.user_id
        WHERE o.status = 'completed'
        GROUP BY u.id, u.name, u.email
        ORDER BY total_spent DESC
        LIMIT 10
    `
    return executeSqlQuery(query)
}

// Example: Common Table Expression (CTE) with recursive query (available in PostgreSQL 8.4+)
const getOrderHierarchy = async (orderId: string) => {
    const query = `
        WITH RECURSIVE order_tree AS (
            -- Base case: get the initial order
            SELECT 
                id,
                parent_order_id,
                amount,
                1 as level
            FROM orders
            WHERE id = $1
            
            UNION ALL
            
            -- Recursive case: get child orders
            SELECT 
                o.id,
                o.parent_order_id,
                o.amount,
                ot.level + 1
            FROM orders o
            JOIN order_tree ot ON o.parent_order_id = ot.id
        )
        SELECT * FROM order_tree
        ORDER BY level, id
    `
    return executeSqlQuery(query)
}

// Example: JSON operations (available in PostgreSQL 9.2+)
const getProductDetails = async () => {
    const query = `
        SELECT 
            p.id,
            p.name,
            p.price,
            p.metadata->>'category' as category,
            p.metadata->>'brand' as brand,
            (p.metadata->>'rating')::float as rating
        FROM products p
        WHERE p.metadata->>'category' = 'electronics'
        AND (p.metadata->>'rating')::float >= 4.5
        ORDER BY rating DESC
    `
    return executeSqlQuery(query)
}

// Example: Date/Time operations (compatible with all PostgreSQL versions)
const getRecentActivity = async () => {
    const query = `
        SELECT 
            u.name,
            o.id as order_id,
            o.created_at,
            EXTRACT(EPOCH FROM (o.created_at - NOW())) / 3600 as hours_ago
        FROM users u
        JOIN orders o ON u.id = o.user_id
        WHERE o.created_at >= NOW() - INTERVAL '7 days'
        ORDER BY o.created_at DESC
    `
    return executeSqlQuery(query)
}
```

> **Note**: The SQL endpoint should only be used in trusted environments as it provides direct database access. Make sure to:
>
> -   Properly validate and sanitize any user input before using it in queries
> -   Use parameterized queries to prevent SQL injection
> -   Consider query performance and add appropriate indexes
> -   Test queries against your specific PostgreSQL version

## API Endpoints

-   `POST /:component` - Create a new record
-   `GET /:component/:id` - Get a record by ID
-   `GET /:component/all` - Get all records
-   `PUT /:component/:id` - Update a record
-   `DELETE /:component/:id` - Delete a record
-   `GET /:component/:id/history` - Get record history
-   `DELETE /:component/all` - Delete all records
-   `DELETE /:component` - Drop the component table

## License

MIT

## Acknowledgments

Scribe was created with **Flypaper Technologies** and is now maintained as **ThoughtPivot** technology.
